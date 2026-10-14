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

  it.each([
    { inputImageDataUrls: ['data:image/png;base64,aW1hZ2U='] },
    { maskDataUrl: 'data:image/png;base64,aW1hZ2U=' },
  ])('参考图或遮罩在请求前提示不支持', async (input) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(callImageApi({ ...opts, ...input })).rejects.toThrow('当前仅支持文生图')
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
