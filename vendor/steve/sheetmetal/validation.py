"""Shared numerical validation without importing the geometry kernel."""
import math

TOL = 1e-7


def fail(message, code='SM_INVALID_GEOMETRY', **context):
    from ..model import FeatureError
    error=FeatureError(message)
    error.sheet_diagnostic=dict(code=code,severity='error',message=message,**context)
    raise error


def number(value, label, minimum=None, maximum=None, positive=False):
    if isinstance(value, bool):
        fail(f'{label} must be a finite number.','SM_INVALID_PARAMETER',parameter=label)
    try:
        value = float(value)
    except (TypeError, ValueError):
        fail(f'{label} must be a finite number.','SM_INVALID_PARAMETER',parameter=label)
    if not math.isfinite(value):
        fail(f'{label} must be a finite number.','SM_INVALID_PARAMETER',parameter=label)
    if (minimum is not None and value < minimum) or (maximum is not None and value > maximum) or (positive and value <= TOL):
        fail(f'{label} is outside its supported range.','SM_INVALID_PARAMETER',parameter=label,measured=value,
             minimum=TOL if positive else minimum,maximum=maximum)
    return value
