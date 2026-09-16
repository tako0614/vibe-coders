import { Config, Vault, type HostConfig } from './config';
import { providerSchema } from '../shared/contracts';
import {
  providerId,
  providerName,
  providerPresets,
  providerUrl,
  type Provider,
} from '../shared/models';

const credentialTarget = (provider: Provider) => `provider:saved:${providerId(provider)}`;
const withoutRevision = ({
  revision: _,
  ...provider
}: NonNullable<HostConfig['provider']>): Provider => provider;
function profiles(config: HostConfig) {
  const values = new Map(config.providers.map((provider) => [providerId(provider), provider]));
  if (config.provider) values.set(providerId(config.provider), withoutRevision(config.provider));
  return values;
}
export function savedProviderCredential(config: Config, vault: Vault, baseUrl: string) {
  const current = config.read().provider;
  if (
    current &&
    current.kind !== 'codex' &&
    providerUrl(current.baseUrl) === providerUrl(baseUrl)
  ) {
    const key = vault.get('provider:main', current.revision);
    if (key) return key;
  }
  return vault.get(credentialTarget({ ...providerPresets[1], baseUrl }), 1);
}
export function providerConnections(config: Config, vault: Vault) {
  const current = config.read();
  const values = new Map(providerPresets.map((provider) => [providerId(provider), provider]));
  for (const [id, provider] of profiles(current)) values.set(id, provider);
  return [...values].map(([id, provider]) => ({
    id,
    name: providerName(provider),
    provider,
    active: !!current.provider && providerId(current.provider) === id,
    credentialSaved:
      provider.kind !== 'codex' && !!savedProviderCredential(config, vault, provider.baseUrl),
  }));
}
export function providerConnection(config: Config, id: string): Provider {
  const provider =
    profiles(config.read()).get(id) || providerPresets.find((value) => providerId(value) === id);
  if (!provider) throw new Error('保存された接続先が見つかりません。');
  return provider;
}

export function saveProvider(
  config: Config,
  vault: Vault,
  revision: number,
  input: Provider,
  credential?: string,
) {
  const parsed = providerSchema.parse(input);
  const provider: Provider =
    parsed.kind === 'codex'
      ? { ...parsed, baseUrl: providerPresets[0].baseUrl, keyRequired: false, supportsImages: true }
      : { ...parsed, kind: 'openai', baseUrl: providerUrl(parsed.baseUrl) };
  let key: string | undefined;
  const next = config.update(revision, (value) => {
    const saved = profiles(value);
    // Archive the active credential before changing its revision/endpoint. This
    // also imports keys entered through human requests or the CLI and old installs.
    const previous = value.provider;
    if (previous && previous.kind !== 'codex') {
      const priorKey = vault.get('provider:main', previous.revision);
      if (priorKey) vault.put(credentialTarget(previous), 1, crypto.randomUUID(), priorKey);
    }
    if (provider.kind !== 'codex' && provider.keyRequired)
      key = credential || vault.get(credentialTarget(provider), 1);
    saved.set(providerId(provider), provider);
    if (saved.size > 30) throw new Error('保存できる接続先は30件までです。');
    value.providers = [...saved.values()];
    value.provider = { ...provider, revision: (previous?.revision || 0) + 1 };
    if (key) {
      vault.put(credentialTarget(provider), 1, crypto.randomUUID(), key);
      vault.put('provider:main', value.provider.revision, crypto.randomUUID(), key);
    } else vault.remove('provider:main');
  });
  return { config: next, credentialReady: !provider.keyRequired || !!key };
}

export function removeProviderCredential(
  config: Config,
  vault: Vault,
  revision: number,
  id: string,
) {
  const provider = providerConnection(config, id);
  if (provider.kind === 'codex') throw new Error('Codexの認証は端末で管理されています。');
  return config.update(revision, (value) => {
    vault.remove(credentialTarget(provider));
    if (value.provider && providerId(value.provider) === id) {
      // Invalidate already-open secret input cards and model verification too.
      value.provider.revision++;
      vault.remove('provider:main');
    }
  });
}
