import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';

export function mountOpenApi(app: INestApplication): void {
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('PerfPortal API')
      .setVersion('1.0.0')
      .setDescription(
        [
          'Ingest and read performance test runs.',
          '',
          'POST /v1/runs and GET /v1/runs/{id} return THE SAME STATUS CODE for the same run state:',
          '  200 ingested, verdict passed or not_evaluated',
          '  422 ingested, verdict failed',
          '  400 bundle rejected (problem+json with a remediation field)',
          '  202 still processing — a TIMING OUTCOME, NEVER AN ERROR. Poll statusUrl.',
          '',
          'A client that treats 202 as failure is misusing this API.',
        ].join('\n'),
      )
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('/v1/docs', app, doc, {
    jsonDocumentUrl: '/v1/openapi.json',
  });
}
