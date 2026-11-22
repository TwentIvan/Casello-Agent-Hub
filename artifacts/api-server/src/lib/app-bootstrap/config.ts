/** Repository modello e dominio di base, letti a ogni chiamata (i test impostano le variabili). */
export function appTemplateRepo(): string {
  return process.env["APP_TEMPLATE_REPO"]?.trim() || "TwentIvan/botcave-modello-app";
}

export function appBaseDomain(): string {
  return (process.env["APP_BASE_DOMAIN"]?.trim() || "fantamister.cloud").toLowerCase();
}
