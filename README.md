# Oficina Billing Service — Fase 4

Microsserviço NestJS independente para orçamento, decisão do cliente e cobrança **após o reparo** usando Mercado Pago Checkout Pro Preferences. Possui PostgreSQL exclusivo, Dockerfile, Helm, infraestrutura Terraform e CI/CD próprios. Nenhum acesso ao banco de outro serviço.

## Execução

Node.js 22, npm e Docker. Copie `.env.example` para `.env`, preencha os segredos locais e execute:

```sh
docker compose up -d db
npm ci
npm run build
npm start
```

Carregue `.env` no processo ao executar diretamente (`node --env-file=.env --require dd-trace/init dist/main.js`); Compose já a injeta. O bootstrap aplica tabelas idempotentes; `npm run migrate` permite aplicá-las separadamente. API porta 3001; Swagger `/api/docs`; JSON `/api/docs-json`; health público `/api/v1/billing/health`; liveness `/api/health/live`; readiness `/api/health/ready` consulta o banco.

## Contratos e autorização

Prefixo `/api/v1/billing`. Respostas JSON diretas. JWT HS256 exige issuer `oficina-auth-serverless`, audience `oficina-api`, assinatura e validade. Clientes acessam apenas `client_id`/`clienteId`/`sub` correspondente à OS. Somente o cliente titular aprova/rejeita. Mecânico gera orçamento apenas se atribuído à OS; administrador/consultor possuem acesso operacional. Filial presente no token deve corresponder à OS.

| Método e caminho | Uso |
|---|---|
| `POST /internal/orders` | Registrar snapshot `{osId,filialId,clienteId,mecanicoId?}`; idempotente e sem reset |
| `GET /internal/orders/:osId` | Snapshot interno completo |
| `GET /orders/:osId` | Snapshot autenticado, orçamento e pagamento |
| `PUT /orders/:osId/budget` | `{items:[{description,quantity,unitPriceCents,pecaId?}]}` |
| `POST /orders/:osId/approve` ou `/reject` | Decisão do cliente |
| `POST /orders/:osId/checkout` | Obter/criar checkout somente após `CreatePayment` |
| `GET /orders/:osId/payment` | Estado financeiro |
| `POST /webhooks/mercadopago?data.id=...` | Assinatura HMAC Mercado Pago obrigatória |

Endpoints internos exigem `X-Internal-Token` igual a `AUTH_CLIENT_LOOKUP_TOKEN`. O corpo é limitado aos campos permitidos; não é possível injetar orçamento aprovado ou reparo concluído na criação. Dinheiro usa inteiros em centavos; quantidade inteira positiva. IDs UUID são aceitos e preservados.

```mermaid
flowchart LR
  OS[OS Service / orquestrador] -->|comandos SQS| B[Billing NestJS]
  OS -->|REST interno: registro e consulta| B
  B --> DB[(PostgreSQL exclusivo)]
  B -->|outbox SQS| OS
  B -->|Preferences / Payments API| MP[Mercado Pago]
  MP -->|webhook HMAC| B
  B --> DD[Datadog APM e logs JSON]
```

Envelope SQS: `{messageId,type,version:1,sagaId,osId,filialId,correlationId,occurredAt,traceparent?,payload}`. Fila própria `INBOX_QUEUE_URL`; eventos destinados a `OS_QUEUE_URL`.

| Comando | Comportamento / evento |
|---|---|
| `AssignMechanic {mecanicoId}` | Atualiza atribuição confiável, `MechanicLinked` |
| `PrepareApprovedBudget {}` | Congela versão aprovada e vincula Saga, `BudgetPrepared {budget}` |
| `ReleaseBudgetPreparation {}` | Descongela sem apagar aprovação, `BudgetReleased` |
| `CreatePayment {}` | Confirma reparo concluído, inicia cobrança, `PaymentPending` e `PaymentCreated {checkoutUrl,preferenceId}` |

Erros de negócio geram `CommandFailed {commandType,reason}`; mensagens inválidas ou falhas transitórias não são removidas e seguem retry/DLQ. Rotas públicas emitem `BudgetGenerated {budget}`, `BudgetApproved {budget}` e `BudgetRejected {budget}`. Pagamento verificado emite `PaymentConfirmed {amountCents,paymentId}` com contexto original da cobrança persistido.

## Saga e consistência

Escolha: **Saga orquestrada pelo OS Service**. Billing é participante: prepara orçamento, libera preparação na compensação e registra cobrança depois da conclusão física. O orçamento pertence a este serviço porque aprovação, preço e pagamento exigem consistência local e auditoria financeira. PostgreSQL permite transação única para documento, inbox e outbox.

`billing_orders` guarda snapshots/versionamento financeiro. Cada alteração usa `SELECT ... FOR UPDATE`; a transação grava estado e eventos em `billing_outbox`. `billing_inbox` deduplica por `messageId` na mesma transação. Publicador usa `FOR UPDATE SKIP LOCKED`, marca entrega apenas após ACK do SQS e repete falhas a cada 10 segundos. Consumo é at least once, com fila de quarentena após cinco recebimentos. Consumidores do OS devem deduplicar eventos. Saga liberada fica registrada e comandos atrasados não a reabrem. Reparo concluído impede compensação financeira automática que apagaria o trabalho realizado.

O serviço não desfaz reparo físico nem restitui peças consumidas. Rejeição de pagamento mantém `AWAITING_PAYMENT`, com preferência existente para nova tentativa do cliente. Somente pagamento `approved`, de referência/valor/moeda corretos, muda Billing para `PAID`; OS libera entrega ao consumir `PaymentConfirmed`. Não há endpoint para simular confirmação em produção.

## Mercado Pago

Configure `MP_ACCESS_TOKEN` de um **vendedor de teste verificado no painel Mercado Pago**, `MP_WEBHOOK_SECRET` da mesma aplicação, `MP_NOTIFICATION_URL` e `MP_BACK_URL`. O prefixo do token não comprova o ambiente: uma credencial de teste Checkout Pro pode começar com `APP_USR`. Antes de usar a credencial na AWS, confira a aplicação e a conta de teste; nunca escolha uma credencial apenas por seu prefixo. O comprador de teste deve ser distinto do vendedor e do mesmo país (Brasil), usando somente os cartões de teste oficiais.

Checkout Pro sempre redireciona para o `init_point` retornado pela preferência, inclusive nos testes com vendedor/comprador de teste. Não existe toggle `MP_SANDBOX` no serviço. `MP_API_BASE_URL` no Helm é `https://api.mercadopago.com`. HTTP é aceito apenas em `NODE_ENV=test/development` para o simulador local; valores recebidos do checkout não são usados para declarar pagamento aprovado.

O procedimento oficial para testar Checkout Pro Preferences usa a credencial de produção da **conta de teste do vendedor** e o `init_point` de produção, com sessão do comprador de teste e cartão oficial de teste: [orientação para testar integrações](https://www.mercadopago.com.br/developers/pt/news/2023/11/16/Questions-on-how-to-test-your-integration--) e [contas de teste Checkout Pro](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/test-accounts). A documentação atual também explica o prefixo `APP_USR` nesse fluxo.

Na validação de homologação de 06/11/2026, o vendedor apresentou `test_user` e site `MLB` na API oficial. O User ID do comprador exibido em **Contas de teste** no painel foi conferido com o pagador; o checkout usou Mastercard oficial de teste com final 3311. O pagamento de R$175,00 foi aprovado, o webhook assinado recebeu HTTP201 e a OS foi liberada para entrega. A API retornou `live_mode=true`, e a consulta pública do comprador não apresentou a tag `test_user`; a identificação desse comprador como conta de teste foi conferida no painel. A flag é registrada como observada, sem afirmar `live_mode=false`.

Na AWS, `MP_NOTIFICATION_URL` deve ser a URL HTTPS pública do Gateway terminando em `/api/v1/billing/webhooks/mercadopago`. `MP_BACK_URL` deve ser a URL HTTPS pública do portal; o adapter preserva origem, path de stage e query configurados e substitui o fragmento por `#/ordens/<osId codificado>` em sucesso, recusa e pendência. Credenciais na URL, esquemas alternativos e URLs locais em produção são rejeitados antes da criação da preferência. `auto_return=approved` é enviado somente para retorno HTTPS público; o simulador HTTP local continua suportado sem esse atributo.

A tentativa e chave idempotente são persistidas **antes** do POST da preferência, que é feito uma única vez. Timeout/erro de resultado desconhecido muda para `UNKNOWN`. A cada 15 ciclos o reconciliador busca preferência e pagamentos por `external_reference=osId:budgetVersion`; ele nunca repete automaticamente o POST. Ausência de resultado mantém o estado pendente para reconciliação/intervenção, evitando duplicidade. Não se presume que Preferences ofereça garantia suficiente de idempotência apenas pelo header.

Webhook verifica `x-signature` HMAC-SHA256, `x-request-id`, `data.id` e tolerância de cinco minutos. Em seguida consulta `GET /v1/payments/:id`; não confia no corpo, redirect ou status informado pelo cliente. Duplicatas não repetem confirmação. O reconciliador inclui tentativas recusadas: uma aprovação posterior na mesma preferência, sem entrega do segundo webhook, ainda é recuperada por consulta autenticada à API. Reembolsos/disputas após reparo exigem tratamento operacional e não reabrem automaticamente uma OS entregue.

Documentação oficial: [Checkout Pro Preferences](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-pro-preferences/overview), [busca de preferências por referência](https://www.mercadopago.com.br/developers/en/reference/online-payments/checkout-pro-preferences/search-preferences/get), [assinatura de notificações](https://www.mercadopago.com.br/developers/en/docs/checkout-pro-preferences/additional-settings/optional-notifications).

Orientação oficial de testes: [credencial de teste e ambiente](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/configure-development-enviroment), [contas de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/test-accounts), [compras com cartões de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/integration-test/test-purchases), [uso de init_point inclusive em contas de teste](https://github.com/mercadopago/mercadopago-claude-marketplace/blob/main/CLAUDE.md).

## Testes e qualidade

```sh
npm run lint
npm run test:cov
npm run build
# PostgreSQL real obrigatório para integração:
TEST_DATABASE_URL=postgresql://billing:billing@localhost:5433/oficina_billing npm run test:integration
```

Threshold de 80% em statements, branches, funções e linhas para **todo código de negócio, HTTP, autenticação, persistência e worker**; somente bootstrap/wiring são excluídos. Testes de domínio, autorização/ownership, webhook HMAC, adaptação Mercado Pago, compensação, duplicatas e HTTP NestJS. Integração com PostgreSQL real verifica rollback total de estado/inbox/outbox, concorrência de duplicatas e recuperação do publicador. SQL em memória nos unitários não substitui essa validação real.

CI publica o artefato `billing-coverage`, executa integração PostgreSQL, lint/tipos, build, container, Helm e Terraform validate. O check Sonar aguarda quality gate e **falha** se faltarem token/projeto/organização. O [CI publicado aprovado](https://github.com/christochula/oficina-billing-service/actions/runs/42214601975) e os relatórios ao final deste README comprovam a execução remota, separadamente da cobertura local.

[Evidência local de build, cobertura, PostgreSQL real, Helm e Terraform](docs/evidence/validation.md).

## AWS, infraestrutura e deploy

`infra/` provisiona RDS PostgreSQL 16 exclusivo, privado e criptografado, subnet group, SG permitindo 5432 apenas dos nós EKS, credencial aleatória em Secrets Manager, SQS/DLQ e ECR próprios. Inputs: `vpc_id`, `private_subnet_ids`, `eks_node_security_group_id`, `environment`, `aws_region`. Inicialize o backend S3 com chave exclusiva e criptografia; o state contém a credencial e requer controle de acesso. Não execute apply sem revisar o plano/custo.

Workflow `Infrastructure` executa `plan` ou `apply` via GitHub Actions, usando dispatch da branch/SHA revisados ou tags operacionais específicas. O plano é a operação padrão; apply exige `BILLING_APPROVED_PLAN_RUN_ID` após revisão, texto e fingerprint semântico idênticos ao novo plano, sem deleção/substituição. Ambos exigem CI completo verde do mesmo SHA/ref antes de credenciais AWS. Configure `TF_STATE_BUCKET`, `VPC_ID`, `PRIVATE_SUBNET_IDS_JSON` e `EKS_NODE_SECURITY_GROUP_ID`. No primeiro provisionamento, execute infraestrutura antes de preencher URLs/secrets do deploy da aplicação. Procedimento em [infraestrutura por GitHub Actions](docs/infrastructure-actions.md).

GitHub **Repository Secret**: `SONAR_TOKEN`; **Repository Variables**: `SONAR_PROJECT_KEY`, `SONAR_ORGANIZATION`, pois CI/Sonar não seleciona Environment. No **Environment homolog**, configure os Secrets temporários `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`; os jobs deploy/infra selecionam explicitamente esse Environment. Variables de homolog: `DATABASE_SECRET_ID` (secret AWS com JSON `{url}`), `JWT_SECRET_ID` (`{secret}`), `BILLING_RUNTIME_SECRET_ID` (`{AUTH_CLIENT_LOOKUP_TOKEN,MP_ACCESS_TOKEN,MP_WEBHOOK_SECRET}`), `BILLING_QUEUE_URL`, `OS_QUEUE_URL`, `MP_NOTIFICATION_URL`, `MP_BACK_URL`, `TF_STATE_BUCKET`, `VPC_ID`, `PRIVATE_SUBNET_IDS_JSON`, `EKS_NODE_SECURITY_GROUP_ID`. AWS Academy usa LabRole existente; renovar credenciais a cada sessão. O nome ECR é `oficina-homolog-billing` tanto no Terraform quanto no deploy.

Deploy independente é executado por GitHub Actions: automaticamente após CI de push na `main`, ou manualmente para o SHA completo e a branch autorizada. Antes de qualquer credencial AWS ou publicação de imagem, o workflow exige os checks `Quality`, `Integration`, `Container` e `Sonar` bem-sucedidos em uma única execução CI do mesmo repositório, branch e SHA, que ainda deve ser HEAD da branch. O primeiro bootstrap explícito (`bootstrap=true` ou tag `phase4/billing-bootstrap-*`) sobe health/LoadBalancer sem token/HMAC Mercado Pago, permitindo configurar Gateway e webhook; o deploy final exige ambos e valida o vendedor de teste antes de persistir o par. Execução por tag `phase4/billing-deploy-*` oferece alternativa ao formulário manual para deploy final; configure Repository Variable `DEPLOY_SOURCE_REF` (padrão `feature/aws-mercadopago-test`). O procedimento e as verificações estão em [deploy por GitHub Actions](docs/deploy-actions.md).

A imagem usa tag imutável `SHA-run_id-run_attempt` e Helm `--atomic --wait` no namespace **oficina-fase4**. Service `oficina-billing:3001`; configurar roteamento público no gateway para as rotas Billing e webhook. Certificado CA RDS oficial incluído na imagem, validação TLS habilitada no Helm. Probes, recursos, duas réplicas, PDB e tags Datadog incluídos.

Datadog inicia antes do Nest, propaga `traceparent` em comandos/eventos e gera spans de processamento SQS. Se o browser não envia W3C válido, o middleware injeta o contexto do span HTTP ativo antes do controller/outbox; contexto recebido válido é preservado. Helm configura `DD_TRACE_PROPAGATION_STYLE_INJECT=datadog,tracecontext`. Com `DD_METRICS_ENABLED=true`, emite distribuição DogStatsD `oficina.api.request.duration_ms` em milissegundos com tags `method`, `status_code`, `service`, `env`, `version`. Falhas de telemetria não interrompem requests. Logs JSON incluem correlação/Saga e IDs de trace quando ativos; não registram token, CPF, connection string ou credenciais Mercado Pago.

Aplicar proteção remota de `main`: PR obrigatório, uma aprovação, checks `Quality`, `Integration`, `Container`, `Sonar`. `.github/settings.yml` documenta as regras; sua presença não aplica nem comprova proteção no GitHub.

## Evidências publicadas de CI, cobertura e deploy

### Snapshot de 10/11/2026, 21h45 (America/Sao_Paulo)

A **OS #2**, `os06a521bf-0d80-49b5-8dd2-1a1c9c961588`, terminou **ENTREGUE**, com pagamento de **R$175,00**. O fluxo observado passou por falta de estoque e preparação `COMPENSATED`, reposição, retry com nova Saga, preparação `COMPLETED`, reparo, Checkout Pro TEST aprovado e entrega. A cobrança ocorreu após o reparo.

- [CI aprovado](https://github.com/christochula/oficina-billing-service/actions/runs/42928186959): `Quality`, `Integration`, `Container` e `Sonar` bem-sucedidos para o SHA `2335d610cfa3c53a838938d1c4c79d9835e90adb`.
- [Deploy final aprovado](https://github.com/christochula/oficina-billing-service/actions/runs/42928569648): mesma revisão, imagem imutável, duas réplicas atualizadas/prontas e health HTTP200. O deploy final preservou a configuração Mercado Pago verificada.
- Cobertura Jest desse código: **82 testes**, statements **99,15%**, branches **92,37%**, funções **97,82%**, linhas **99,68%**. O CI publica o artifact `billing-coverage`; esses percentuais são do Jest, não do painel Sonar.
- A consulta canônica do pagamento confirmou referência da OS, valor **175 BRL** e as contas de teste conferidas para o cenário. O provedor retornou **`live_mode=true`**, valor preservado como observado. Em 11/11/2026 às **00:43:09.702Z**, o Billing registrou `billing.payment.checked` com `source=webhook`; o OS consumiu `PaymentConfirmed` e liberou a entrega. As evidências sanitizadas do provedor são mantidas localmente, sem publicar identificadores de pagamento ou dados de acesso.
- Datadog foi validado na UI/API: latência HTTP dos três serviços, seis séries de filas e sete séries de Saga; **p95 com séries dos três serviços**. A amostra observada inclui um trace com OS, Billing e Production, além dos logs correlacionados das etapas da Saga. [Dashboard de homologação](https://app.datadoghq.com/dashboard/u6t-x9c-awx/oficina--operao-e-observabilidade--homolog).
- [Guia para gravar a demonstração](https://github.com/christochula/oficina-api/blob/feature/phase4-distributed/docs/entrega/pronto-para-gravar.md), mantido no repositório OS.

### Histórico de 06/11/2026 — OS #1

Snapshot de 06/11/2026, fonte implantada `952f4f14`:

- [CI aprovado](https://github.com/christochula/oficina-billing-service/actions/runs/42214601975): checks `Quality`, `Integration`, `Container` e `Sonar`, incluindo quality gate obrigatório.
- [SonarCloud](https://sonarcloud.io/dashboard?id=christochula-oficina_oficina-billing-service): cobertura **95,7%**, linhas 99,7% e branches 92,2%; quality gate aprovado. São métricas Sonar, distintas do resumo Jest local.
- [Relatório de cobertura](https://github.com/christochula/oficina-billing-service/actions/runs/42214601975/artifacts/13501326628): artifact `billing-coverage` da mesma execução CI.
- [Deploy final aprovado](https://github.com/christochula/oficina-billing-service/actions/runs/42240956838): validação do vendedor de teste e do par token/HMAC, imagem imutável do SHA `952f4f14eb9c8a4e74393616acb0597746bbe4b4`, duas réplicas prontas e health público HTTP200 após o rollout.
- [OpenAPI público para Swagger](https://8phthn792m.execute-api.us-east-1.amazonaws.com/api/v1/billing/openapi.json) e [health pelo Gateway](https://8phthn792m.execute-api.us-east-1.amazonaws.com/api/v1/billing/health), verificados em 06/11/2026.

A disponibilidade da homologação depende da sessão ativa do AWS Academy; renovar credenciais e fazer o deploy pelo GitHub Actions após a expiração.
