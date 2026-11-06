# Deploy por GitHub Actions

O workflow `Deploy` aplica a aplicação no namespace `oficina-fase4`. A infraestrutura usa o workflow separado `Infrastructure`. Credenciais AWS temporárias ficam exclusivamente nos Secrets do Environment `homolog`; `SONAR_TOKEN` e as variáveis Sonar são configurados no repositório para os jobs CI.

Antes de qualquer acesso AWS ou publicação de imagem, `scripts/check-deploy-gates.mjs` consulta a API do GitHub e exige:

- SHA completo de 40 caracteres e branch do mesmo repositório, sem referência de PR ou tag como branch de origem.
- SHA ainda igual ao HEAD atual da branch de origem.
- Execução mais recente do workflow `ci.yml` para essa branch e SHA, disparada por push ou workflow manual, concluída com sucesso.
- Jobs `Quality`, `Integration`, `Container` e `Sonar` concluídos com sucesso nessa única execução; checks ausentes, pulados ou provenientes de outra execução bloqueiam o deploy.

Falha de consulta à API também bloqueia o deploy. O job Sonar aguarda o quality gate real; configuração ausente não é tratada como sucesso. Os testes desse mecanismo e dos helpers de infraestrutura/runtime executam na etapa `Quality` do CI e localmente com `node --test scripts/*.test.mjs`.

## Execução manual de uma feature

Após publicar e revisar a branch autorizada, aguarde seus quatro checks CI. No formulário `Deploy`, selecione a mesma branch para carregar o workflow e informe `target_ref` com o nome da branch e `target_sha` com seu SHA completo. O workflow confere também se o SHA/ref do próprio disparo corresponde aos inputs; selecionar `main` e informar o SHA de uma feature é recusado.

Não é necessário alterar a branch padrão nem integrar a feature à `main` para executar esse fluxo. Uma nova alteração na branch exige nova execução CI para o novo SHA. O input `bootstrap` é `false` por padrão; deploy normal exige configuração completa de pagamento.

## Primeiro deploy aguardando o webhook

Existe uma dependência inicial: o Gateway precisa do LoadBalancer Billing, enquanto o painel Mercado Pago precisa da URL HTTPS do Gateway para permitir configurar o webhook. Para resolver isso, selecionar explicitamente `bootstrap=true` no dispatch, ou usar tag `phase4/billing-bootstrap-<identificador>` no mesmo SHA aprovado. O gate de CI é idêntico ao deploy final.

Nesse modo, o helper `configure-runtime-secrets.mjs` cria/preenche o runtime Billing com somente `AUTH_CLIENT_LOOKUP_TOKEN` obtido do secret canônico compartilhado. Não recebe, grava ou injeta token Mercado Pago nem chave HMAC nos pods. Não existem placeholders: o webhook sem chave rejeita notificações e as chamadas ao provedor não conseguem autenticar. O workflow sobe o serviço, valida rollout e publica o LoadBalancer para configurar o Gateway; o resumo Actions identifica `pending-webhook`. Não usar esse estágio para executar ordens com cobrança.

Se o runtime já contiver credenciais de pagamento, o workflow recusa bootstrap e exige deploy final, preservando os valores persistidos. O helper não remove credenciais existentes para forçar um estado pendente.

Depois de criar o Gateway, configurar sua URL de notificação e eventos no painel Mercado Pago, salvar e obter a chave HMAC. Configurar os Secrets `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` do Environment `homolog`, além de `MP_NOTIFICATION_URL` e `MP_BACK_URL` HTTPS nas Variables. Executar novamente com `bootstrap=false` ou uma tag `phase4/billing-deploy-*`.

No deploy final, o helper consulta `/users/me` pela API oficial e exige vendedor de teste brasileiro antes de persistir o par token/HMAC de forma atômica. JWT e token interno compartilhados são preservados. Ausência de qualquer campo bloqueia o deploy antes da publicação da imagem. Os valores são manipulados em memória/arquivos temporários privados; não aparecem no resumo nem em artifacts.

Configurar Variables `JWT_SECRET_ID`, `AUTH_CLIENT_LOOKUP_SECRET_ID` e `BILLING_RUNTIME_SECRET_ID` com os nomes/ARNs dos secrets correspondentes. O secret JWT/lookup deve ter sido inicializado pelo workflow OS; a criação/atualização de valores Billing também ocorre por Actions. `EKS_CLUSTER_NAME` pode selecionar o cluster e usa `oficina-homolog-eks` por padrão.

## Alternativa por tag

Se o GitHub ainda não disponibiliza `workflow_dispatch` porque a definição está apenas na feature, o mesmo workflow aceita tags `phase4/billing-deploy-*` para deploy final e `phase4/billing-bootstrap-*` para o estágio explícito sem credenciais MP. A tag deve apontar exatamente para o HEAD da branch configurada na **Repository Variable** `DEPLOY_SOURCE_REF`, cujo padrão é `feature/aws-mercadopago-test`. Use um identificador rastreável no sufixo, por exemplo `phase4/billing-deploy-<sha-curto>-<data>`.

O push da tag é uma solicitação efetiva de deploy. Antes dele, revise o commit e a configuração `homolog`, confira os quatro checks CI da branch e confirme que o SHA da tag é o mesmo. Uma tag antiga ou apontando para outro commit é recusada, mesmo que esse commit tenha tido CI verde no passado. O CI adicional eventualmente disparado pela tag não substitui o CI da branch de origem.

## Resultado

A imagem publicada no ECR `oficina-homolog-billing` recebe a tag imutável `SHA-run_id-run_attempt`, inclusive em reexecuções. Helm usa `--atomic --wait`; o workflow aguarda o rollout e registra no resumo o SHA e o endereço do LoadBalancer na porta 3001 para configurar o Gateway. As URLs `MP_NOTIFICATION_URL` e `MP_BACK_URL` vêm das Variables de `homolog` e devem ser as URLs HTTPS públicas do Gateway/portal. O checkout usa `init_point` com a credencial de vendedor de teste verificada no painel Mercado Pago.
