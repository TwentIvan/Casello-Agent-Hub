/** Errore OAuth (RFC 6749 / 7591): codice, descrizione fissa in italiano e stato HTTP. */
export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }

  toJSON(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}
