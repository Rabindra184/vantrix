import { SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import { buildOpenApiDocument } from './openapi/document.js';

export function mountOpenApi(app: INestApplication): void {
  // buildOpenApiDocument() returns a genuine OpenAPI 3.1 document (built by
  // hand from the Zod schemas in @perfportal/contracts — see
  // openapi/schemas.ts and openapi/document.ts). It is NOT run through
  // @nestjs/swagger's DocumentBuilder/SwaggerModule.createDocument, which
  // only emits 3.0-shaped output; SwaggerModule.setup() itself just serves
  // whatever document object it is given, so it works fine here.
  //
  // The cast is required, not just convenient: @nestjs/swagger's
  // `OpenAPIObject`/`SchemaObject` types model the OpenAPI 3.0 JSON Schema
  // dialect (`SchemaObject.type` is a single string, `exclusiveMinimum` is a
  // boolean) and cannot express 3.1's dialect, which this document uses
  // (nullability via `anyOf`, in this case — see schemas.ts for why the
  // dialect choice avoids that specific incompatibility anyway). The
  // document's actual validity is checked at runtime by a real OpenAPI
  // validator in apps/api/test/openapi.integration.test.ts, not by this type.
  const doc = buildOpenApiDocument() as unknown as OpenAPIObject;
  SwaggerModule.setup('/v1/docs', app, doc, {
    jsonDocumentUrl: '/v1/openapi.json',
  });
}
