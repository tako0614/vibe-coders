import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { Config, Vault, type McpConfig } from './config';
import { HumanService } from './human';
import { Store } from './store';

type Session = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  state?: string;
  expires?: number;
  cardId?: string;
  authorizationUrl?: string;
};
export class McpOAuth implements OAuthClientProvider {
  constructor(
    readonly config: Config,
    readonly vault: Vault,
    readonly store: Store,
    readonly human: HumanService,
    readonly connection: McpConfig,
    readonly conversationId: string,
  ) {}
  private get target() {
    return `oauth:${this.connection.name}`;
  }
  read(): Session {
    if (this.config.targetVersion(`mcp:${this.connection.name}`) !== this.connection.revision)
      throw new Error('OAuth connection changed.');
    const value = this.vault.get(this.target, this.connection.revision);
    return value ? JSON.parse(value) : {};
  }
  private save(patch: Partial<Session>) {
    this.config.lock(() => {
      if (this.config.targetVersion(`mcp:${this.connection.name}`) !== this.connection.revision)
        throw new Error('OAuth connection changed.');
      this.vault.put(
        this.target,
        this.connection.revision,
        crypto.randomUUID(),
        JSON.stringify({ ...this.read(), ...patch }),
      );
    });
  }
  get redirectUrl() {
    const web = this.config.read().web!;
    return `${web.origin || `http://${web.hostname}:${web.port}`}/api/mcp/oauth/callback`;
  }
  get clientMetadata() {
    return {
      client_name: 'Vibe Coders',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.connection.oauthClientSecret ? 'client_secret_post' : 'none',
      ...(this.connection.oauthScope ? { scope: this.connection.oauthScope } : {}),
    };
  }
  state() {
    const state = crypto.randomUUID() + crypto.randomUUID();
    this.save({ state, expires: Date.now() + 15 * 60000 });
    return state;
  }
  clientInformation() {
    const session = this.read();
    if (this.connection.oauthClientId) {
      const secret = this.vault.get(
        `oauth-client:${this.connection.name}`,
        this.connection.revision,
      );
      if (this.connection.oauthClientSecret && !secret)
        throw new Error('OAuthクライアントシークレットを専用入力から保存してください。');
      return {
        client_id: this.connection.oauthClientId,
        ...(secret ? { client_secret: secret } : {}),
      };
    }
    return session.client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.save({ client });
  }
  tokens() {
    return this.read().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.save({ tokens });
  }
  saveCodeVerifier(verifier: string) {
    this.save({ verifier });
  }
  codeVerifier() {
    const v = this.read().verifier;
    if (!v) throw new Error('OAuth verifier missing.');
    return v;
  }
  redirectToAuthorization(url: URL) {
    this.store.assertEnabled();
    const session = this.read();
    const card = this.human.create(this.conversationId, {
      kind: 'action',
      externalCompletion: true,
      title: `${this.connection.name} の認証`,
      message:
        'ページでログインすると自動的に接続を再開します。認証コードをチャットに貼らないでください。',
      url: url.href,
      targetId: `mcp:${this.connection.name}`,
      fields: [],
      expiresAt: session.expires,
      dedupeKey: `oauth:${session.state}`,
    });
    this.save({ cardId: card.id, authorizationUrl: url.href });
  }
  consumeState(state: string) {
    const session = this.read();
    if (
      !session.state ||
      session.state !== state ||
      !session.expires ||
      session.expires <= Date.now()
    )
      throw new Error('OAuth state is invalid or expired.');
    if (!session.cardId || this.human.get(session.cardId).state !== 'pending')
      throw new Error('OAuth request is closed.');
    this.save({ state: undefined, expires: undefined, authorizationUrl: undefined });
    return session.cardId;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all')
      this.save({ client: undefined, tokens: undefined, verifier: undefined, state: undefined });
    else if (scope === 'client') this.save({ client: undefined });
    else if (scope === 'tokens') this.save({ tokens: undefined });
    else if (scope === 'verifier') this.save({ verifier: undefined });
  }
}
