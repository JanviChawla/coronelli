"""document author and year fields

Revision ID: h8i9j0k1l2m3
Revises: g7h8i9j0k1l2
Create Date: 2026-09-15 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "h8i9j0k1l2m3"
down_revision = "g7h8i9j0k1l2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("source_documents", sa.Column("author", sa.String(), nullable=True))
    op.add_column("source_documents", sa.Column("year", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("source_documents", "year")
    op.drop_column("source_documents", "author")
