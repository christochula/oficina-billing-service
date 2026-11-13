# Infraestrutura por GitHub Actions

O workflow `Infrastructure` (`.github/workflows/infra.yml`) é o caminho de provisionamento AWS deste serviço. Não aplica recursos implicitamente ao publicar código. A operação `plan` é padrão; `apply` depende de uma revisão registrada e usa plano salvo na própria execução, validado contra a revisão.

O gate anterior às credenciais AWS exige HEAD atual da branch, SHA completo e uma única execução CI mais recente de push/dispatch do mesmo repositório/branch/SHA, com os jobs `Quality`, `Integration`, `Container` e `Sonar` concluídos com sucesso. Resultados de PR merge, fork, outro SHA, jobs pulados e combinação de runs diferentes são rejeitados.

## Variáveis e dependências

No Environment `homolog`, configurar os Secrets temporários `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`. Variables necessárias:

| Variable | Uso |
| --- | --- |
| `TF_STATE_BUCKET` | Bucket privado/versionado do backend Terraform |
| `VPC_ID` | VPC da plataforma EKS |
| `PRIVATE_SUBNET_IDS_JSON` | Array JSON de ao menos duas subnets em AZs diferentes |
| `EKS_NODE_SECURITY_GROUP_ID` | SG dos nós autorizados a alcançar o PostgreSQL |
| `BILLING_APPROVED_PLAN_RUN_ID` | ID do plan bem-sucedido que foi revisado antes do apply |

A Repository Variable `DEPLOY_SOURCE_REF` identifica a branch de origem para tags (padrão `feature/aws-mercadopago-test`). Configurar também a qualidade do CI no repositório conforme README. A chave de state exclusiva é `oficina-fase4/billing/terraform.tfstate`, com criptografia e S3 lockfile. O state contém credenciais; seu acesso deve ser restrito. O workflow nunca publica state, JSON bruto ou plano binário em artifacts.

A infraestrutura cria PostgreSQL16 privado `db.t3.micro` com 20GB, SG exclusivo permitindo apenas os nós EKS, senha aleatória em Secrets Manager, filas SQS/DLQ e ECR imutável. Verificar permissões, quotas e crédito Academy antes do apply. O banco tem proteção contra exclusão e snapshot final obrigatório.

## Plan, revisão e apply

No formulário `Run workflow`, selecionar a branch revisada e informar `target_ref`, `target_sha` completo e `operation=plan`. Os inputs precisam coincidir com a branch selecionada e HEAD atual. Pela CLI GitHub:

```bash
REF=feature/aws-mercadopago-test
SHA="$(git rev-parse HEAD)" # precisa coincidir com HEAD remoto da branch
gh workflow run infra.yml --ref "$REF" -f target_ref="$REF" -f target_sha="$SHA" -f operation=plan
```

Revisar a conta/role mostradas na execução, recursos/custo e o artifact `billing-plan-<SHA>-<RUN_ID>`. Ele contém somente `billing-plan.txt` (`terraform show -no-color`) e `billing-plan-review.json` (metadata pública e SHA256 semântico). O hash considera valores sensíveis e os estados unknown, sem emitir seus conteúdos. Deleção e substituição de recursos são bloqueadas.

Registrar o ID aprovado no Environment e solicitar apply do mesmo SHA:

```bash
gh variable set BILLING_APPROVED_PLAN_RUN_ID --env homolog --body "$PLAN_RUN_ID"
gh workflow run infra.yml --ref "$REF" -f target_ref="$REF" -f target_sha="$SHA" -f operation=apply
```

O workflow verifica repositório/workflow/SHA/sucesso do run aprovado e baixa apenas o artifact esperado. Gera novo plano, compara o texto byte a byte e o fingerprint semântico. Drift inclusive de valores sensíveis exige novo plan/revisão. O apply usa o binário recém-salvo na execução; esse arquivo efêmero é removido ao final. Criar novo run para repetir plan, pois artifacts revisados não são sobrescritos.

## Fallback por tags

Se a versão do workflow em feature ainda não puder receber dispatch, publicar uma tag única no SHA revisado: `phase4/billing-plan-<identificador>` para plan e `phase4/billing-apply-<identificador>` para apply. Configure `DEPLOY_SOURCE_REF` no repositório antes. A tag precisa continuar no HEAD dessa branch com os quatro gates de CI verdes; apply mantém a exigência de plano revisado. O fluxo não muda a branch padrão nem faz merge na `main`.

Depois do provisionamento, preencher as URLs/secret IDs do deploy e executar o workflow da aplicação conforme [deploy por Actions](deploy-actions.md). O namespace de aplicação é `oficina-fase4`; o banco legado e os states de outros serviços são independentes.
