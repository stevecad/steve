"""Resource location for editable source and frozen desktop builds."""
import sys
from pathlib import Path

RESOURCE_ROOT = Path(sys._MEIPASS) if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[2]
