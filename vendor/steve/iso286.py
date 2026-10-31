"""ISO 286 limits and fits: the limit deviations of a tolerance class (H7, g6, …) at a nominal size.

    from steve.iso286 import deviations
    deviations("H7", 12)  # (Decimal("0.018"), Decimal("0"))  upper and lower, in mm

Values are ISO 286-1:2010's tables (standard tolerance grades, Table 1; fundamental deviations of shafts and holes,
Tables 2 and 3, with Δ and their special cases) for nominal sizes up to 3150 mm, kept in micrometres exactly as
tabulated: never worked out from the i-factor formulas, which round differently. A size range runs "above X up to and
including Y", so 30 mm is in 18–30. A class the standard doesn't define at a size raises ValueError saying so.

Above 500 mm the standard defines grades IT1 to IT18 (no IT01 or IT0), shafts d to u and holes D to U only (no j or
J), and holes K, M and N take ES = 0, −m and −n with no Δ (N up to IT8; P to U likewise: ES = −ei).
"""
from __future__ import annotations

import bisect
import re
from decimal import Decimal

# Hole classes are written in capitals, shaft classes in lower case; the grade is IT01, IT0, IT1 … IT18.
FIT = re.compile(r"(?P<letters>A|B|C|CD|D|E|EF|F|FG|G|H|JS|J|K|M|N|P|R|S|T|U|V|X|Y|Z|ZA|ZB|ZC"
                 r"|a|b|c|cd|d|e|ef|f|fg|g|h|js|j|k|m|n|p|r|s|t|u|v|x|y|z|za|zb|zc)(?P<grade>01|0|1[0-8]|[1-9])")
LARGEST = 3150  # mm: ISO 286 goes this far.
LARGE = 500  # mm: above this the larger sizes' rules apply.

# Size ranges (mm, upper bounds, "above the previous up to and including this"). Tolerance grades and Δ use the main
# ranges; fundamental deviations use the intermediate ones where the standard splits them.
MAIN = (3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150)
STEPS = (3, 6, 10, 14, 18, 24, 30, 40, 50, 65, 80, 100, 120, 140, 160, 180, 200, 225, 250, 280, 315, 355, 400, 450, 500,
         560, 630, 710, 800, 900, 1000, 1120, 1250, 1400, 1600, 1800, 2000, 2240, 2500, 2800, 3150)

# Standard tolerance grades (ISO 286-1 Table 1; IT01 and IT0 from its Annex A), µm, per MAIN range.
GRADES = {
    "01": "0.3 0.4 0.4 0.5 0.6 0.6 0.8 1 1.2 2 2.5 3 4",
    "0": "0.5 0.6 0.6 0.8 1 1 1.2 1.5 2 3 4 5 6",
    "1": "0.8 1 1 1.2 1.5 1.5 2 2.5 3.5 4.5 6 7 8",
    "2": "1.2 1.5 1.5 2 2.5 2.5 3 4 5 7 8 9 10",
    "3": "2 2.5 2.5 3 4 4 5 6 8 10 12 13 15",
    "4": "3 4 4 5 6 7 8 10 12 14 16 18 20",
    "5": "4 5 6 8 9 11 13 15 18 20 23 25 27",
    "6": "6 8 9 11 13 16 19 22 25 29 32 36 40",
    "7": "10 12 15 18 21 25 30 35 40 46 52 57 63",
    "8": "14 18 22 27 33 39 46 54 63 72 81 89 97",
    "9": "25 30 36 43 52 62 74 87 100 115 130 140 155",
    "10": "40 48 58 70 84 100 120 140 160 185 210 230 250",
    "11": "60 75 90 110 130 160 190 220 250 290 320 360 400",
    "12": "100 120 150 180 210 250 300 350 400 460 520 570 630",
    "13": "140 180 220 270 330 390 460 540 630 720 810 890 970",
    "14": "250 300 360 430 520 620 740 870 1000 1150 1300 1400 1550",
    "15": "400 480 580 700 840 1000 1200 1400 1600 1850 2100 2300 2500",
    "16": "600 750 900 1100 1300 1600 1900 2200 2500 2900 3200 3600 4000",
    "17": "1000 1200 1500 1800 2100 2500 3000 3500 4000 4600 5200 5700 6300",
    "18": "1400 1800 2200 2700 3300 3900 4600 5400 6300 7200 8100 8900 9700",
}

# Shafts' fundamental deviations (ISO 286-1 Table 2), µm, per STEPS range: the size of es for a to h (es is minus
# it), of ei for j (minus it) and of ei for k to zc. "-" where the standard gives none.
SHAFTS = {
    "a": "270 270 280 290 290 300 300 310 320 340 360 380 410 460 520 580 660 740 820 920 1050 1200 1350 1500 1650",
    "b": "140 140 150 150 150 160 160 170 180 190 200 220 240 260 280 310 340 380 420 480 540 600 680 760 840",
    "c": "60 70 80 95 95 110 110 120 130 140 150 170 180 200 210 230 240 260 280 300 330 360 400 440 480",
    "cd": "34 46 56" + " -" * 22,
    "d": "20 30 40 50 50 65 65 80 80 100 100 120 120 145 145 145 170 170 170 190 190 210 210 230 230",
    "e": "14 20 25 32 32 40 40 50 50 60 60 72 72 85 85 85 100 100 100 110 110 125 125 135 135",
    "ef": "10 14 18" + " -" * 22,
    "f": "6 10 13 16 16 20 20 25 25 30 30 36 36 43 43 43 50 50 50 56 56 62 62 68 68",
    "fg": "4 6 8" + " -" * 22,
    "g": "2 4 5 6 6 7 7 9 9 10 10 12 12 14 14 14 15 15 15 17 17 18 18 20 20",
    "h": " ".join(["0"] * 25),
    "j5": "2 2 2 3 3 4 4 5 5 7 7 9 9 11 11 11 13 13 13 16 16 18 18 20 20",
    "j7": "4 4 5 6 6 8 8 10 10 12 12 15 15 18 18 18 21 21 21 26 26 28 28 32 32",
    "j8": "6" + " -" * 24,
    "k": "0 1 1 1 1 2 2 2 2 2 2 3 3 3 3 3 4 4 4 4 4 4 4 5 5",  # grades 4 to 7; 0 for the others
    "m": "2 4 6 7 7 8 8 9 9 11 11 13 13 15 15 15 17 17 17 20 20 21 21 23 23",
    "n": "4 8 10 12 12 15 15 17 17 20 20 23 23 27 27 27 31 31 31 34 34 37 37 40 40",
    "p": "6 12 15 18 18 22 22 26 26 32 32 37 37 43 43 43 50 50 50 56 56 62 62 68 68",
    "r": "10 15 19 23 23 28 28 34 34 41 43 51 54 63 65 68 77 80 84 94 98 108 114 126 132",
    "s": "14 19 23 28 28 35 35 43 43 53 59 71 79 92 100 108 122 130 140 158 170 190 208 232 252",
    "t": "- - - - - - 41 48 54 66 75 91 104 122 134 146 166 180 196 218 240 268 294 330 360",
    "u": "18 23 28 33 33 41 48 60 70 87 102 124 144 170 190 210 236 258 284 315 350 390 435 490 540",
    "v": "- - - - 39 47 55 68 81 102 120 146 172 202 228 252 284 310 340 385 425 475 530 595 660",
    "x": "20 28 34 40 45 54 64 80 97 122 146 178 210 248 280 310 350 385 425 475 525 590 660 740 820",
    "y": "- - - - - 63 75 94 114 144 174 214 254 300 340 380 425 470 520 580 650 730 820 920 1000",
    "z": "26 35 42 50 60 73 88 112 136 172 210 258 310 365 415 465 520 575 640 710 790 900 1000 1100 1250",
    "za": "32 42 52 64 77 98 118 148 180 226 274 335 400 470 535 600 670 740 820 920 1000 1150 1300 1450 1600",
    "zb": "40 50 67 90 108 136 160 200 242 300 360 445 525 620 700 780 880 960 1050 1200 1300 1500 1650 1850 2100",
    "zc": "60 80 97 130 150 188 218 274 325 405 480 585 690 800 900 1000 1150 1250 1350 1550 1700 1900 2100 2400 2600",
}
# Holes J6, J7 and J8: ES (ISO 286-1 Table 3), µm, per STEPS range.
HOLES_J = {
    "6": "2 5 5 6 6 8 8 10 10 13 13 16 16 18 18 18 22 22 22 25 25 29 29 33 33",
    "7": "4 6 8 10 10 12 12 14 14 18 18 22 22 26 26 26 30 30 30 36 36 39 39 43 43",
    "8": "6 10 12 15 15 20 20 24 24 28 28 34 34 41 41 41 47 47 47 55 55 60 60 66 66",
}
SHAFT_J = {"5": "j5", "6": "j5", "7": "j7", "8": "j8"}  # j5 and j6 share their ei

# Above 500 mm, continuing the rows above: grades per MAIN range (500–630 … 2500–3150; Table 1) and shafts' deviations
# per STEPS range (500–560 … 2800–3150; Table 2). A grade or letter not listed isn't defined there.
GRADES_LARGE = {
    "1": "9 10 11 13 15 18 22 26",
    "2": "11 13 15 18 21 25 30 36",
    "3": "16 18 21 24 29 35 41 50",
    "4": "22 25 28 33 39 46 55 68",
    "5": "32 36 40 47 55 65 78 96",
    "6": "44 50 56 66 78 92 110 135",
    "7": "70 80 90 105 125 150 175 210",
    "8": "110 125 140 165 195 230 280 330",
    "9": "175 200 230 260 310 370 440 540",
    "10": "280 320 360 420 500 600 700 860",
    "11": "440 500 560 660 780 920 1100 1350",
    "12": "700 800 900 1050 1250 1500 1750 2100",
    "13": "1100 1250 1400 1650 1950 2300 2800 3300",
    "14": "1750 2000 2300 2600 3100 3700 4400 5400",
    "15": "2800 3200 3600 4200 5000 6000 7000 8600",
    "16": "4400 5000 5600 6600 7800 9200 11000 13500",
    "17": "7000 8000 9000 10500 12500 15000 17500 21000",
    "18": "11000 12500 14000 16500 19500 23000 28000 33000",
}
SHAFTS_LARGE = {
    "d": "260 260 290 290 320 320 350 350 390 390 430 430 480 480 520 520",
    "e": "145 145 160 160 170 170 195 195 220 220 240 240 260 260 290 290",
    "f": "76 76 80 80 86 86 98 98 110 110 120 120 130 130 145 145",
    "g": "22 22 24 24 26 26 28 28 30 30 32 32 34 34 38 38",
    "h": " ".join(["0"] * 16),
    "k": " ".join(["0"] * 16),  # every grade
    "m": "26 26 30 30 34 34 40 40 48 48 58 58 68 68 76 76",
    "n": "44 44 50 50 56 56 66 66 78 78 92 92 110 110 135 135",
    "p": "78 78 88 88 100 100 120 120 140 140 170 170 195 195 240 240",
    "r": "150 155 175 185 210 220 250 260 300 330 370 400 440 460 550 580",
    "s": "280 310 340 380 430 470 520 580 640 720 820 920 1000 1100 1250 1400",
    "t": "400 450 500 560 620 680 780 840 960 1050 1200 1350 1500 1650 1900 2100",
    "u": "600 660 740 840 940 1050 1150 1300 1450 1600 1850 2000 2300 2500 2900 3200",
}


def _row(text: str, large: str | None, count: int) -> list[Decimal | None]:
    values = text.split() + (large.split() if large else ["-"] * count)
    return [None if value == "-" else Decimal(value) for value in values]


GRADES = {grade: _row(values, GRADES_LARGE.get(grade), 8) for grade, values in GRADES.items()}
SHAFTS = {letter: _row(values, SHAFTS_LARGE.get(letter), 16) for letter, values in SHAFTS.items()}
HOLES_J = {grade: _row(values, None, 16) for grade, values in HOLES_J.items()}
assert all(len(row) == len(MAIN) for row in GRADES.values())
assert all(len(row) == len(STEPS) for row in (*SHAFTS.values(), *HOLES_J.values()))
MICRONS = Decimal(1000)


def _range(size: float, bounds) -> int:
    return bisect.bisect_left(bounds, size)


def tolerance(grade: str, size: float) -> Decimal:
    """The standard tolerance ITgrade at a nominal size, in µm."""
    if grade in ("14", "15", "16", "17", "18") and size <= 1:
        raise ValueError(f"IT{grade} isn't defined for sizes up to 1 mm.")
    value = GRADES[grade][_range(size, MAIN)]
    if value is None:
        raise ValueError(f"IT{grade} isn't defined above {LARGE} mm (ISO 286 has IT1 to IT18 there).")
    return value


def _delta(grade: str, size: float) -> Decimal:
    """Δ for holes K to N (up to IT8) and P to ZC (up to IT7): ITn − IT(n−1), as Table 3's columns are; 0 up to 3 mm
    and above 500 mm."""
    if size <= 3 or size > LARGE:
        return Decimal(0)
    return tolerance(grade, size) - tolerance(str(int(grade) - 1), size)


def _shaft(letters: str, grade: str, size: float, name: str) -> Decimal:
    """A shaft's tabulated fundamental deviation's size, in µm."""
    step = _range(size, STEPS)
    if letters == "j":
        if grade not in SHAFT_J:
            raise ValueError(f"{name}: ISO 286 defines j only in grades 5 to 8.")
        value = SHAFTS[SHAFT_J[grade]][step]
    elif letters == "k":
        value = SHAFTS["k"][step] if grade in ("4", "5", "6", "7") else Decimal(0)
    else:
        value = SHAFTS[letters][step]
    if value is None:
        raise ValueError(f"{name} isn't defined by ISO 286 at {size:g} mm.")
    return value


def deviations(fit: str, size: float) -> tuple[Decimal, Decimal]:
    """(upper, lower) limit deviations in mm of tolerance class `fit` (like "H7" or "g6") at nominal size `size` mm."""
    match = FIT.fullmatch(fit)
    if not match:
        raise ValueError(f"{fit!r} isn't an ISO 286 tolerance class: a hole's is in capitals (H7), a shaft's in lower case (g6).")
    letters, grade = match["letters"], match["grade"]
    if not size > 0:
        raise ValueError(f"{fit}: an ISO 286 fit needs a size above 0 mm.")
    if size > LARGEST:
        raise ValueError(f"{fit}: ISO 286 covers sizes up to {LARGEST} mm; this size is {size:g} mm. "
                         "Write its limits as a tolerance instead.")
    hole, low = letters.isupper(), letters.lower()
    if low in ("a", "b") and size <= 1:
        raise ValueError(f"{fit}: ISO 286 doesn't define {letters} for sizes up to 1 mm.")
    it = tolerance(grade, size)
    if low == "js":
        half = it / 2
        if grade in ("7", "8", "9", "10", "11") and it % 2:  # Odd: the even value below, so ±ITn/2 is whole µm.
            half = (it - 1) / 2
        upper, lower = half, -half
    elif not hole:
        value = _shaft(low, grade, size, fit)
        if low in ("a", "b", "c", "cd", "d", "e", "ef", "f", "fg", "g", "h"):
            upper = -value
            lower = upper - it
        elif low == "j":
            lower = -value
            upper = lower + it
        else:
            lower = value
            upper = lower + it
    elif low in ("a", "b", "c", "cd", "d", "e", "ef", "f", "fg", "g", "h"):
        lower = _shaft(low, grade, size, fit)
        upper = lower + it
    elif low == "j":
        if grade not in HOLES_J:
            raise ValueError(f"{fit}: ISO 286 defines J only in grades 6 to 8.")
        upper = HOLES_J[grade][_range(size, STEPS)]
        if upper is None:
            raise ValueError(f"{fit} isn't defined by ISO 286 at {size:g} mm.")
        lower = upper - it
    else:
        small = grade in ("01", "0", "1", "2")
        if low in ("k", "m", "n") and size > LARGE:  # The larger sizes' rule: no Δ.
            if low == "n" and int(grade) > 8:
                raise ValueError(f"{fit}: ISO 286 tabulates N above {LARGE} mm only up to grade 8. "
                                 "Write its limits as a tolerance instead.")
            upper = -SHAFTS[low][_range(size, STEPS)]
        elif low in ("k", "m", "n"):
            if low == "n" and not small and int(grade) > 8 and size <= 1:
                raise ValueError(f"{fit}: ISO 286 doesn't define N above grade 8 for sizes up to 1 mm.")
            if small:
                raise ValueError(f"{fit}: ISO 286 has no Δ for grade {grade}, so {letters}{grade} isn't defined.")
            base = SHAFTS[low][_range(size, STEPS)]
            if size <= 3:
                upper = {"k": Decimal(0), "m": Decimal(-2), "n": Decimal(-4)}[low]
            elif int(grade) <= 8:
                upper = -base + _delta(grade, size)
                if low == "m" and grade == "6" and 250 < size <= 315:
                    upper = Decimal(-9)  # Table 3's special case for M6 at 250–315 mm.
            else:
                upper = {"k": Decimal(0), "m": -base, "n": Decimal(0)}[low]
        else:
            if small and size <= LARGE:  # (above 500 mm there's no Δ to need)
                raise ValueError(f"{fit}: ISO 286 has no Δ for grade {grade}, so {letters}{grade} isn't defined.")
            upper = -_shaft(low, grade, size, fit)
            if int(grade) <= 7:
                upper += _delta(grade, size)
        lower = upper - it
    return (upper + 0) / MICRONS, (lower + 0) / MICRONS  # (+ 0: no "-0")
