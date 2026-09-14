"""candidate temporal and relation fields

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-09-14 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = "b2c3d4e5f6a7"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "candidates",
        sa.Column("temporal_interpretation", sa.String(), nullable=False, server_default="static"),
    )
    op.add_column(
        "candidates",
        sa.Column(
            "first_revealed_at_section_id",
            sa.String(),
            sa.ForeignKey("source_sections.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "candidates",
        sa.Column("relation_kind", sa.String(), nullable=True),
    )
    op.add_column(
        "candidates",
        sa.Column(
            "relation_target_id",
            sa.String(),
            sa.ForeignKey("candidates.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("candidates", "relation_target_id")
    op.drop_column("candidates", "relation_kind")
    op.drop_column("candidates", "first_revealed_at_section_id")
    op.drop_column("candidates", "temporal_interpretation")
