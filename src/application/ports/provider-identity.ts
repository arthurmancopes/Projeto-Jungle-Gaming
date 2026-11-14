/**
 * Ponto de extensão da autenticação (não implementada — ver ARCHITECTURE.md, seção 15).
 * Com um IdP, a implementação devolveria o provider_id do token validado e a camada HTTP
 * recusaria requisições cujo providerId do corpo fosse diferente.
 */
export interface ProviderIdentityPort {
  /** Identidade do provedor autenticado, ou undefined quando não há autenticação. */
  resolve(request: { headers: Record<string, unknown> }): string | undefined;
}
