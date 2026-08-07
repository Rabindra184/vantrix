import { SetMetadata } from '@nestjs/common';

export type TokenScope = 'ingest' | 'read';
export const SCOPES_KEY = 'perfportal:scopes';
export const Scopes = (...scopes: TokenScope[]) => SetMetadata(SCOPES_KEY, scopes);
