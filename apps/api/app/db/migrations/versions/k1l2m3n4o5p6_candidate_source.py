"""candidates: add source column to distinguish manual vs extraction-generated entries

Revision ID: k1l2m3n4o5p6
Revises: j0k1l2m3n4o5
Create Date: 2026-09-16
"""

from alembic import op
import sqlalchemy as sa

revision = "k1l2m3n4o5p6"
down_revision = "j0k1l2m3n4o5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("candidates", sa.Column("source", sa.String(), nullable=False, server_default="extraction"))


def downgrade() -> None:
    op.drop_column("candidates", "source")
