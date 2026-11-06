# Evidência local de validação — 05/11/2026

- `npm run build`: aprovado, TypeScript estrito.
- `npm run test:cov -- --silent`: 76 testes aprovados em 9 suítes; statements 99,09%, branches 92,21%, funções 98,8%, linhas 99,66%. Inclui Checkout Pro usando somente `init_point`, retorno seguro para a OS, rejeição de configuração insegura, recuperação de aprovação após recusa sem webhook, corrida de checkout/contexto da Saga, contrato DogStatsD e propagação do span HTTP ativo. Relatório completo gerado em `coverage/lcov-report/index.html` (artefato local, não versionado).
- `npm run test:integration` contra PostgreSQL 16 real em Docker: 2 testes aprovados; rollback total de estado/inbox/outbox e deduplicação concorrente com recuperação do outbox.
- `terraform -chdir=infra init -backend=false`, `validate` e `fmt -check`: aprovados; nenhum recurso AWS aplicado.
- `helm lint helm/oficina-billing` com Helm 3.17.3: aprovado, sem erros.

Esta evidência relata execução local. CI/SonarCloud, publicação remota, proteção de branch e deploy AWS precisam de suas próprias execuções/evidências; não foram declarados como realizados.
