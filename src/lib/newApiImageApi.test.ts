import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { callImageApi } from './api'
import { DEFAULT_SETTINGS, getCustomProviderDefinition, normalizeSettings, switchApiProfileProvider } from './apiProfiles'
import { getCustomQueuedImageResult } from './openaiCompatibleImageApi'

const profile = {
  ...DEFAULT_SETTINGS.profiles[0],
  id: 'newapi',
  provider: 'newapi-async',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-secret',
}
const settings = { ...DEFAULT_SETTINGS, baseUrl: profile.baseUrl, apiKey: profile.apiKey, profiles: [profile], activeProfileId: profile.id }
const opts = { settings, prompt: '一只猫', params: { ...DEFAULT_PARAMS, n: 2 }, inputImageDataUrls: [] }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const artifactUrl = 'https://images.example.com/v1/tasks/task-1/artifacts/image-1/content?access=signature'
const artifacts = { artifacts: [{ type: 'image', content_url: artifactUrl }] }
const image = () => new Response(new Blob(['image'], { type: 'image/png' }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('New API 异步生图', () => {
  it('提交一次，经历排队和运行状态后下载全部图片，不向产物域名泄露密钥', async () => {
    vi.useFakeTimers()
    const onCustomTaskEnqueued = vi.fn()
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ task_id: 'task-1', status: 'SUBMITTED' }, 202))
      .mockResolvedValueOnce(json({ status: 'QUEUED' }))
      .mockResolvedValueOnce(json({ status: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(json({ status: 'SUCCESS' }))
      .mockResolvedValueOnce(json({ artifacts: [...artifacts.artifacts, { type: 'image', content_url: `${artifactUrl}2` }] }))
      .mockResolvedValueOnce(image())
      .mockResolvedValueOnce(image())
    const resultPromise = callImageApi({ ...opts, onCustomTaskEnqueued })
    await vi.runAllTimersAsync()
    const result = await resultPromise
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.com/v1/tasks/openai-image',
      ...Array(3).fill('https://api.example.com/v1/tasks/task-1'),
      'https://api.example.com/v1/tasks/task-1/artifacts',
      artifactUrl,
      `${artifactUrl}2`,
    ])
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ prompt: '一只猫', n: 2, model: profile.model })
    expect(onCustomTaskEnqueued).toHaveBeenCalledExactlyOnceWith({ taskId: 'task-1' })
    expect(fetch.mock.calls[4][1]?.headers).toEqual({ Authorization: 'Bearer test-secret' })
    expect(fetch.mock.calls[5][1]?.headers).toBeUndefined()
    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U=', 'data:image/png;base64,aW1hZ2U='])
  })

  it('已保存的任务直接查询结果，不重复提交', async () => {
    const restored = normalizeSettings(JSON.parse(JSON.stringify(settings)))
    const restoredProfile = restored.profiles[0]
    const provider = getCustomProviderDefinition(restored, restoredProfile.provider)!
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ status: 'SUCCESS' }))
      .mockResolvedValueOnce(json(artifacts))
      .mockResolvedValueOnce(image())
    const result = await getCustomQueuedImageResult(restoredProfile, provider, 'task/1', DEFAULT_PARAMS)
    expect(fetch.mock.calls[0][0]).toBe('https://api.example.com/v1/tasks/task%2F1')
    expect(fetch.mock.calls[1][0]).toBe('https://api.example.com/v1/tasks/task%2F1/artifacts')
    expect(fetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true)
    expect(result.images).toHaveLength(1)
  })

  it('显示后端任务失败原因', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ task_id: 'task-1' }, 202))
      .mockResolvedValueOnce(json({ status: 'FAILURE', fail_reason: '上游生图失败' }))
    await expect(callImageApi(opts)).rejects.toThrow('上游生图失败')
  })

  it.each([401, 404])('查询 HTTP %s 时停止并显示错误', async (status) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ task_id: 'task-1' }, 202))
      .mockResolvedValueOnce(json({ error: { message: '任务不可访问' } }, status))
    await expect(callImageApi(opts)).rejects.toThrow('任务不可访问')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('网络断开、限流和产物暂时不可用后继续查询同一任务', async () => {
    vi.useFakeTimers()
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ task_id: 'task-1' }, 202))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({ status: 'SUCCESS' }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ status: 'SUCCESS' }))
      .mockResolvedValueOnce(json(artifacts))
      .mockResolvedValueOnce(image())
    const promise = callImageApi(opts)
    await vi.runAllTimersAsync()
    expect((await promise).images).toHaveLength(1)
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  })

  it.each([
    { artifacts: [] },
    { artifacts: [{ type: 'image', content_url: 'javascript:alert(1)' }] },
  ])('拒绝空结果或无效产物链接', async (payload) => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ task_id: 'task-1' }, 202))
      .mockResolvedValueOnce(json({ status: 'SUCCESS' }))
      .mockResolvedValueOnce(json(payload))
    await expect(callImageApi(opts)).rejects.toThrow(/图片产物/)
  })

  it('拒绝缺少任务 ID 的提交响应', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ status: 'SUBMITTED' }, 202))
    await expect(callImageApi(opts)).rejects.toThrow('无法从响应中提取异步任务 ID')
  })

  it.each([false, true])('使用 JSON 提交参考图编辑并取得异步结果，遮罩：%s', async (withMask) => {
    const inputImageDataUrls = ['data:image/png;base64,aW1hZ2U=', 'data:image/webp;base64,aW1hZ2U=']
    const maskDataUrl = withMask ? 'data:image/png;base64,bWFzaw==' : undefined
    const onCustomTaskEnqueued = vi.fn()
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ task_id: 'edit-1' }, 202))
      .mockResolvedValueOnce(json({ status: 'SUCCESS' }))
      .mockResolvedValueOnce(json(artifacts))
      .mockResolvedValueOnce(image())
    const result = await callImageApi({ ...opts, inputImageDataUrls, maskDataUrl, onCustomTaskEnqueued })
    expect(fetch.mock.calls[0][0]).toBe('https://api.example.com/v1/tasks/openai-image')
    const init = fetch.mock.calls[0][1]!
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      model: profile.model,
      prompt: opts.prompt,
      n: 2,
      action: 'image_to_image',
      images: inputImageDataUrls.map((image_url) => ({ image_url })),
    })
    if (withMask) expect(body.mask).toEqual({ image_url: maskDataUrl })
    else expect(body).not.toHaveProperty('mask')
    expect(body).not.toHaveProperty('image')
    expect(onCustomTaskEnqueued).toHaveBeenCalledExactlyOnceWith({ taskId: 'edit-1' })
    expect(fetch.mock.calls[1][0]).toBe('https://api.example.com/v1/tasks/edit-1')
    expect(result.images).toEqual(['data:image/png;base64,aW1hZ2U='])
  })

  it('文生图不携带编辑字段', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ task_id: 'task-1' }, 202))
      .mockResolvedValueOnce(json({ status: 'SUCCESS' }))
      .mockResolvedValueOnce(json(artifacts))
      .mockResolvedValueOnce(image())
    await callImageApi(opts)
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body))
    expect(body).not.toHaveProperty('images')
    expect(body).not.toHaveProperty('mask')
    expect(body).not.toHaveProperty('action')
  })

  it.each([
    { input: { maskDataUrl: 'data:image/png;base64,aW1hZ2U=' }, error: '遮罩编辑需要至少一张参考图' },
    { input: { inputImageDataUrls: Array(17).fill('data:image/png;base64,aW1hZ2U=') }, error: '编辑最多支持 16 张参考图' },
  ])('无主图遮罩或参考图超限时不提交请求', async ({ input, error }) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(callImageApi({ ...opts, ...input })).rejects.toThrow(error)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('完整 JSON 请求超过 4 MiB 时在提交前报错', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(callImageApi({
      ...opts,
      prompt: '猫'.repeat(1400000),
      inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='],
    })).rejects.toThrow('不能超过 4 MiB')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('切换服务商保留地址和模型，导入旧配置后仍能识别异步服务商', () => {
    const provider = getCustomProviderDefinition(settings, profile.provider)!
    const switched = switchApiProfileProvider({ ...profile, provider: 'openai', apiMode: 'responses', streamImages: true }, provider.id, provider)
    expect(switched).toMatchObject({ baseUrl: profile.baseUrl, model: profile.model, apiMode: 'images', streamImages: false, apiProxy: false })
    const normalized = normalizeSettings({ ...settings, profiles: [{ ...profile, apiProxy: true, streamImages: true }], providerOrder: ['openai'] })
    expect(normalized.profiles[0]).toMatchObject({ provider: 'newapi-async', apiProxy: false, streamImages: false })
    expect(normalized.providerOrder).toContain('newapi-async')
  })
})
