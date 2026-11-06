import { oauthBase } from "./config";

/** Documento «protected resource» (RFC 9728) di /mcp. */
export function protectedResourceMetadata() {
  const { issuer, resource } = oauthBase();
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  };
}

/** Documento dell'authorization server (RFC 8414). */
export function authorizationServerMetadata() {
  const { issuer } = oauthBase();
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    client_id_metadata_document_supported: true,
    scopes_supported: ["mcp", "api:read", "api:write"],
  };
}
