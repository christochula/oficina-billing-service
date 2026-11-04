terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "s3" {}
}
provider "aws" { region = var.aws_region }
variable "aws_region" {
  type    = string
  default = "us-east-1"
}
variable "environment" {
  type    = string
  default = "homolog"
}
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "eks_node_security_group_id" { type = string }
locals { name = "oficina-${var.environment}-billing" }
resource "aws_sqs_queue" "dlq" {
  name                      = "${local.name}-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_sqs_queue" "inbox" {
  name                       = local.name
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 5 })
}
resource "aws_ecr_repository" "billing" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "AES256" }
}
output "billing_queue_url" { value = aws_sqs_queue.inbox.url }
output "billing_queue_arn" { value = aws_sqs_queue.inbox.arn }
output "billing_dlq_url" { value = aws_sqs_queue.dlq.url }
output "ecr_repository_url" { value = aws_ecr_repository.billing.repository_url }
resource "random_password" "database" {
  length  = 32
  special = false
}
resource "aws_db_subnet_group" "billing" {
  name       = local.name
  subnet_ids = var.private_subnet_ids
}
resource "aws_security_group" "database" {
  name        = "${local.name}-database"
  description = "Only EKS nodes can reach the Billing PostgreSQL"
  vpc_id      = var.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.eks_node_security_group_id]
  }
}
resource "aws_db_instance" "billing" {
  identifier                = local.name
  engine                    = "postgres"
  engine_version            = "16"
  instance_class            = "db.t3.micro"
  allocated_storage         = 20
  max_allocated_storage     = 50
  storage_type              = "gp3"
  storage_encrypted         = true
  db_name                   = "oficina_billing"
  username                  = "billingadmin"
  password                  = random_password.database.result
  db_subnet_group_name      = aws_db_subnet_group.billing.name
  vpc_security_group_ids    = [aws_security_group.database.id]
  publicly_accessible       = false
  backup_retention_period   = 7
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"
}
resource "aws_secretsmanager_secret" "connection" {
  name                    = "oficina/${var.environment}/billing/database/connection"
  recovery_window_in_days = 7
}
resource "aws_secretsmanager_secret_version" "connection" {
  secret_id     = aws_secretsmanager_secret.connection.id
  secret_string = jsonencode({ url = "postgresql://billingadmin:${urlencode(random_password.database.result)}@${aws_db_instance.billing.address}:5432/oficina_billing" })
}
output "database_secret_id" { value = aws_secretsmanager_secret.connection.id }
