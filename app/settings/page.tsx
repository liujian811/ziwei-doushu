'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';

interface ModelConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutSeconds: number;
  hasApiKey: boolean;
  configured: boolean;
}

interface ModelForm {
  baseUrl: string;
  model: string;
  temperature: string;
  maxTokens: string;
  timeoutSeconds: string;
}

interface TestResult {
  ok: boolean;
  model: string;
  reply: string;
}

type Operation = 'loading' | 'login' | 'save' | 'test' | 'logout' | null;

class SettingsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : response.status === 401 ? '登录已过期，请重新登录。' : '请求未完成，请稍后重试。';
    throw new SettingsError(message, response.status);
  }
  if (!data || typeof data !== 'object') throw new SettingsError('服务器返回了无法识别的结果，请稍后重试。');
  return data as T;
}

function toForm(config: ModelConfig): ModelForm {
  return {
    baseUrl: config.baseUrl || '',
    model: config.model || '',
    temperature: String(config.temperature ?? 0.7),
    maxTokens: String(config.maxTokens ?? 2048),
    timeoutSeconds: String(config.timeoutSeconds ?? 90),
  };
}

export default function SettingsPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [form, setForm] = useState<ModelForm | null>(null);
  const [savedForm, setSavedForm] = useState<ModelForm | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [operation, setOperation] = useState<Operation>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const busyRef = useRef(false);
  const busy = operation !== null;
  const dirty = !!form && (JSON.stringify(form) !== JSON.stringify(savedForm) || apiKey.length > 0);

  function acceptConfig(value: ModelConfig) {
    setConfig(value);
    const nextForm = toForm(value);
    setForm(nextForm);
    setSavedForm(nextForm);
    setApiKey('');
  }

  function clearSession() {
    setAuthenticated(false);
    setConfig(null);
    setForm(null);
    setSavedForm(null);
    setApiKey('');
    setPassword('');
    setTestResult(null);
  }

  function reportError(reason: unknown) {
    if (reason instanceof SettingsError && reason.status === 401) clearSession();
    setError(reason instanceof SettingsError ? reason.message : '网络连接失败，请稍后重试。');
  }

  useEffect(() => {
    const controller = new AbortController();
    async function initialize() {
      try {
        const session = await requestJson<{ authenticated: boolean }>('/api/admin/session', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setAuthenticated(session.authenticated);
        if (session.authenticated) {
          const value = await requestJson<ModelConfig>('/api/admin/model', { signal: controller.signal });
          if (!controller.signal.aborted) acceptConfig(value);
        }
      } catch (reason) {
        if (!controller.signal.aborted) reportError(reason);
      } finally {
        if (!controller.signal.aborted) setOperation(null);
      }
    }
    void initialize();
    return () => controller.abort();
  }, []);

  async function perform(action: Exclude<Operation, null>, task: () => Promise<void>) {
    if (busyRef.current || operation !== null) return;
    busyRef.current = true;
    setOperation(action);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (reason) {
      reportError(reason);
    } finally {
      busyRef.current = false;
      setOperation(null);
    }
  }

  async function retryLoad() {
    await perform('loading', async () => {
      const session = await requestJson<{ authenticated: boolean }>('/api/admin/session');
      setAuthenticated(session.authenticated);
      if (session.authenticated) acceptConfig(await requestJson<ModelConfig>('/api/admin/model'));
      else clearSession();
    });
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password) return;
    await perform('login', async () => {
      try {
        await requestJson('/api/admin/session', { method: 'POST', body: JSON.stringify({ password }) });
      } finally {
        setPassword('');
      }
      setAuthenticated(true);
      acceptConfig(await requestJson<ModelConfig>('/api/admin/model'));
      setNotice('已登录。可以配置模型，或返回原排盘标签页开始解读。');
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form) return;
    await perform('save', async () => {
      setTestResult(null);
      const value = await requestJson<ModelConfig>('/api/admin/model', {
        method: 'PUT',
        body: JSON.stringify({
          baseUrl: form.baseUrl.trim(),
          model: form.model.trim(),
          apiKey: apiKey.trim(),
          temperature: Number(form.temperature),
          maxTokens: Number(form.maxTokens),
          timeoutSeconds: Number(form.timeoutSeconds),
        }),
      });
      acceptConfig(value);
      setNotice('模型配置已保存。新的 AI 解读将使用这份配置。');
    });
  }

  async function testSavedConfig() {
    if (dirty || !config?.configured) return;
    await perform('test', async () => {
      setTestResult(null);
      const result = await requestJson<TestResult>('/api/admin/model/test', { method: 'POST', body: '{}' });
      if (!result.ok) throw new SettingsError('模型测试未通过，请检查配置后重试。');
      setTestResult(result);
      setNotice('模型连接测试成功。');
    });
  }

  async function logout() {
    await perform('logout', async () => {
      await requestJson('/api/admin/session', { method: 'DELETE' });
      clearSession();
      setNotice('已退出登录。');
    });
  }

  function updateField(field: keyof ModelForm, value: string) {
    setForm(current => current ? { ...current, [field]: value } : current);
    setNotice('');
    setTestResult(null);
  }

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6" style={{ background: 'var(--bg-0)', color: 'var(--tx-0)' }} aria-busy={busy}>
      <div className="mx-auto max-w-3xl">
        <nav aria-label="页面导航" className="mb-8 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm" style={{ color: 'var(--tx-2)' }}>
          <Link href="/">← 返回首页</Link>
          <Link href="/chart">返回排盘</Link>
          {authenticated && (
            <button type="button" onClick={logout} disabled={busy} className="ml-auto disabled:opacity-50">
              {operation === 'logout' ? '正在退出…' : '退出登录'}
            </button>
          )}
        </nav>

        <header className="mb-7">
          <p className="mb-2 text-xs tracking-widest" style={{ color: 'var(--ac)' }}>紫微命盘 · 管理设置</p>
          <h1 className="mb-3 text-2xl font-semibold">模型配置</h1>
          <p className="text-sm leading-7" style={{ color: 'var(--tx-2)' }}>
            连接你的 OpenAI 兼容模型，用于命盘解读与合盘分析。配置保存在服务器，应用更新后仍会保留。
          </p>
        </header>

        {error && <div role="alert" className="mb-5 rounded-xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--ji)', color: 'var(--tx-0)' }}>{error}</div>}
        {notice && <div role="status" className="mb-5 rounded-xl border px-4 py-3 text-sm" style={{ borderColor: 'var(--ac-bdr)', background: 'var(--ac-bg)' }}>{notice}</div>}

        {authenticated === null && (
          <section className="card p-6">
            <p role="status" className="text-sm" style={{ color: 'var(--tx-2)' }}>{busy ? '正在检查登录状态…' : '暂时无法确认登录状态。'}</p>
            {!busy && <button type="button" onClick={retryLoad} className="btn-primary mt-4">重新检查</button>}
          </section>
        )}

        {authenticated === false && (
          <section className="card p-6 sm:p-8" aria-labelledby="login-heading">
            <h2 id="login-heading" className="mb-2 text-lg font-medium">管理员登录</h2>
            <p className="mb-6 text-sm leading-6" style={{ color: 'var(--tx-2)' }}>
              模型设置和 AI 解读均需要登录。登录后可回到原排盘标签页继续使用。
            </p>
            <form onSubmit={login} className="space-y-4">
              <div>
                <label htmlFor="admin-password" className="mb-2 block text-sm">管理密码</label>
                <input id="admin-password" type="password" autoComplete="current-password" required value={password}
                  onChange={event => setPassword(event.target.value)} disabled={busy} className="input-base w-full" />
              </div>
              <button type="submit" disabled={busy || !password} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">
                {operation === 'login' ? '正在登录…' : '登录'}
              </button>
            </form>
            <p className="mt-5 text-xs leading-6" style={{ color: 'var(--tx-2)' }}>登录会话通过安全 Cookie 保存；页面不会把管理密码或 API Key 写入本地存储。</p>
          </section>
        )}

        {authenticated && !form && (
          <section className="card p-6">
            <p className="text-sm" style={{ color: 'var(--tx-2)' }}>{busy ? '正在读取模型配置…' : '暂时无法读取模型配置。'}</p>
            {!busy && <button type="button" onClick={retryLoad} className="btn-primary mt-4">重新读取</button>}
          </section>
        )}

        {authenticated && form && config && (
          <section className="card p-6 sm:p-8" aria-labelledby="config-heading">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <h2 id="config-heading" className="text-lg font-medium">模型服务</h2>
              <span className="rounded-full px-3 py-1 text-xs" style={{ color: 'var(--ac)', background: 'var(--ac-bg)' }}>
                {dirty ? '有未保存的更改' : config.configured ? '已配置' : '待配置'}
              </span>
            </div>
            <form onSubmit={save} className="space-y-6">
              <fieldset disabled={busy} className="space-y-6 disabled:opacity-60">
                <div>
                  <label htmlFor="model-base-url" className="mb-2 block text-sm">API 地址（Base URL）</label>
                  <input id="model-base-url" type="url" required autoComplete="off" spellCheck={false} value={form.baseUrl}
                    onChange={event => updateField('baseUrl', event.target.value)} placeholder="https://your-model-provider.example/v1"
                    className="input-base w-full" aria-describedby="base-url-help" />
                  <p id="base-url-help" className="mt-2 text-xs leading-6" style={{ color: 'var(--tx-2)' }}>填写服务商提供的 OpenAI 兼容 API 根地址，通常以 /v1 结尾。</p>
                </div>
                <div>
                  <label htmlFor="model-name" className="mb-2 block text-sm">模型名称</label>
                  <input id="model-name" required autoComplete="off" spellCheck={false} value={form.model}
                    onChange={event => updateField('model', event.target.value)} placeholder="填写服务商提供的模型 ID" className="input-base w-full" />
                </div>
                <div>
                  <label htmlFor="model-api-key" className="mb-2 block text-sm">API Key{config.hasApiKey ? '（已保存）' : ''}</label>
                  <input id="model-api-key" type="password" autoComplete="new-password" spellCheck={false} required={!config.hasApiKey} value={apiKey}
                    onChange={event => { setApiKey(event.target.value); setNotice(''); setTestResult(null); }}
                    placeholder={config.hasApiKey ? '留空保留现有密钥；输入新密钥可替换' : '输入模型服务的 API Key'}
                    className="input-base w-full" aria-describedby="key-help" />
                  <p id="key-help" className="mt-2 text-xs leading-6" style={{ color: 'var(--tx-2)' }}>密钥只提交给本站服务器保存，保存后不会回传到页面。</p>
                </div>
                <div className="grid gap-5 sm:grid-cols-3">
                  <div>
                    <label htmlFor="model-temperature" className="mb-2 block text-sm">Temperature</label>
                    <input id="model-temperature" type="number" min="0" max="2" step="0.1" required value={form.temperature}
                      onChange={event => updateField('temperature', event.target.value)} className="input-base w-full" aria-describedby="temperature-help" />
                    <p id="temperature-help" className="mt-2 text-xs leading-6" style={{ color: 'var(--tx-2)' }}>数值越低，回答通常越稳定。</p>
                  </div>
                  <div>
                    <label htmlFor="model-max-tokens" className="mb-2 block text-sm">最大输出 Token</label>
                    <input id="model-max-tokens" type="number" min="128" max="8192" step="1" required value={form.maxTokens}
                      onChange={event => updateField('maxTokens', event.target.value)} className="input-base w-full" aria-describedby="tokens-help" />
                    <p id="tokens-help" className="mt-2 text-xs leading-6" style={{ color: 'var(--tx-2)' }}>限制单次回答长度与用量。</p>
                  </div>
                  <div>
                    <label htmlFor="model-timeout" className="mb-2 block text-sm">超时（秒）</label>
                    <input id="model-timeout" type="number" min="10" max="180" step="1" required value={form.timeoutSeconds}
                      onChange={event => updateField('timeoutSeconds', event.target.value)} className="input-base w-full" aria-describedby="timeout-help" />
                    <p id="timeout-help" className="mt-2 text-xs leading-6" style={{ color: 'var(--tx-2)' }}>超过此时间会停止等待。</p>
                  </div>
                </div>
              </fieldset>
              <div className="flex flex-wrap gap-3 border-t pt-6" style={{ borderColor: 'var(--bdr)' }}>
                <button type="submit" disabled={busy || !dirty} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">
                  {operation === 'save' ? '正在保存…' : '保存配置'}
                </button>
                <button type="button" onClick={testSavedConfig} disabled={busy || dirty || !config.configured}
                  className="rounded-full border px-5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ borderColor: 'var(--ac-bdr)', color: 'var(--ac)' }} aria-describedby="test-help">
                  {operation === 'test' ? '正在测试…' : '测试已保存配置'}
                </button>
              </div>
              <p id="test-help" className="text-xs leading-6" style={{ color: 'var(--tx-2)' }}>
                {dirty ? '请先保存更改，再测试连接。' : !config.configured ? '完成并保存模型配置后，即可测试连接。' : '测试会向已保存的模型发送一次简短请求，可能产生少量用量。'}
              </p>
            </form>
            {testResult && (
              <div className="mt-6 rounded-xl border p-4" style={{ borderColor: 'var(--ac-bdr)', background: 'var(--ac-bg)' }}>
                <h3 className="text-sm font-medium">测试成功 · {testResult.model}</h3>
                <p className="mt-2 whitespace-pre-wrap break-words text-sm" style={{ color: 'var(--tx-2)' }}>{testResult.reply}</p>
              </div>
            )}
          </section>
        )}

        <footer className="mt-6 text-xs leading-6" style={{ color: 'var(--tx-2)' }}>
          AI 解读会向已配置的模型发送命盘星曜信息和对话内容。本站不会自动附带姓名；请勿在提问中填写不必要的个人信息。
        </footer>
      </div>
    </main>
  );
}
