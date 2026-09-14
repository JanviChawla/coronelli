"""extraction_run cost and cache columns

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-09-14 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "c3d4e5f6a7b8"
down_revision = "b2c3d4e5f6a7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("extraction_runs", sa.Column("input_tokens", sa.Integer(), nullable=True))
    op.add_column("extraction_runs", sa.Column("output_tokens", sa.Integer(), nullable=True))
    op.add_column("extraction_runs", sa.Column("estimated_cost_usd", sa.Float(), nullable=True))
    op.add_column("extraction_runs", sa.Column("section_content_hash", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("extraction_runs", "section_content_hash")
    op.drop_column("extraction_runs", "estimated_cost_usd")
    op.drop_column("extraction_runs", "output_tokens")
    op.drop_column("extraction_runs", "input_tokens")
