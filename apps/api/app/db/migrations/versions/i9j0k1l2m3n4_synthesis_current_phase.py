"""synthesis_runs.current_phase for live progress polling

Revision ID: i9j0k1l2m3n4
Revises: h8i9j0k1l2m3
Branch_labels: None
Depends_on: None
"""
from alembic import op
import sqlalchemy as sa

revision = "i9j0k1l2m3n4"
down_revision = "h8i9j0k1l2m3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("synthesis_runs", sa.Column("current_phase", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("synthesis_runs", "current_phase")
