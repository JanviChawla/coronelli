"""synthesis tables and candidate is_mention

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-09-14 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "d4e5f6a7b8c9"
down_revision = "c3d4e5f6a7b8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "candidates",
        sa.Column("is_mention", sa.Boolean(), nullable=False, server_default="0"),
    )

    op.create_table(
        "synthesis_runs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("document_id", sa.String(), sa.ForeignKey("source_documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("synthesis_prompt_version", sa.String(), nullable=False),
        sa.Column("raw_response", sa.JSON(), nullable=True),
        sa.Column("evidence_hash", sa.String(64), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "synthesis_items",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("synthesis_run_id", sa.String(), sa.ForeignKey("synthesis_runs.id", ondelete="CASCADE"), nullable=False),
        sa.Column("document_id", sa.String(), sa.ForeignKey("source_documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("review_state", sa.String(), nullable=False, server_default="provisional"),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("ordinal", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("synthesis_items")
    op.drop_table("synthesis_runs")
    op.drop_column("candidates", "is_mention")
