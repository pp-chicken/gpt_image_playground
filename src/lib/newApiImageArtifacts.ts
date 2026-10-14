import type { ApiProfile } from '../types'
import { blobToDataUrl } from './dataUrl'
import { buildApiUrl } from './devProxy'
import { getApiErrorMessage, type CallApiResult } from './imageApiShared'
import { apiFetch } from './platform'

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    void response.body?.cancel().catch(() => undefined)
    // 交给现有轮询重试，不重新提交生图任务。
    throw new Error(`网络连接暂时失败：HTTP ${response.status}`)
  }
  throw new Error(await getApiErrorMessage(response))
}

export async function getNewApiTaskImages(profile: ApiProfile, taskId: string, mime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const response = await apiFetch(buildApiUrl(profile.baseUrl, `tasks/${encodeURIComponent(taskId)}/artifacts`), {
    headers: { Authorization: `Bearer ${profile.apiKey}` },
    cache: 'no-store',
    signal,
  })
  await checkResponse(response)
  const payload = await response.json()
  const artifacts: unknown[] = Array.isArray(payload?.artifacts) ? payload.artifacts : []
  const urls = artifacts.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const artifact = item as Record<string, unknown>
    if (artifact.type !== 'image') return []
    if (typeof artifact.content_url !== 'string' || !/^https?:\/\//i.test(artifact.content_url)) {
      throw new Error('New API 返回的图片产物链接无效')
    }
    return [artifact.content_url]
  })
  if (!urls.length) throw new Error('New API 任务已完成，但没有返回图片产物')

  const images: string[] = []
  try {
    for (const url of urls) {
      // 产物链接自带访问签名，可能使用独立域名，不能向其发送 API 密钥。
      const imageResponse = await apiFetch(url, { cache: 'no-store', signal })
      await checkResponse(imageResponse)
      const blob = await imageResponse.blob()
      if (!blob.size || (blob.type && !blob.type.startsWith('image/') && blob.type !== 'application/octet-stream')) {
        throw new Error('New API 图片产物未返回有效的图片内容')
      }
      images.push(await blobToDataUrl(blob.type === 'application/octet-stream' ? new Blob([blob], { type: mime }) : blob, mime))
    }
  } catch (err) {
    if (err instanceof Error) Object.assign(err, { rawImageUrls: urls })
    throw err
  }
  return { images, rawImageUrls: urls }
}
