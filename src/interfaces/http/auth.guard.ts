import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { ProviderIdentityPort } from "../../application/ports/provider-identity";

/**
 * Ponto de extensão da autenticação — hoje é no-op (decisão documentada no ARCHITECTURE.md, seção 15).
 * Com um IdP (ex.: Keycloak), este guard validaria o JWT (assinatura via JWKS, iss, aud, exp)
 * e rejeitaria a requisição com 401. Os endpoints de health não usam este guard.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

/** Sem autenticação não há identidade verificada: o providerId do payload é aceito como veio. */
export class UnauthenticatedProviderIdentity implements ProviderIdentityPort {
  resolve(): string | undefined {
    return undefined;
  }
}
