"""map_entity aliases column

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-09-14 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "e5f6a7b8c9d0"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("map_entities", sa.Column("aliases", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("map_entities", "aliases")
