import os

# The dashboard PIN lock (app/auth.py) is on by default; the older API tests run without it.
# tests/test_trlive.py builds its apps with require_pin=True.
os.environ.setdefault("STONKS_REQUIRE_PIN", "0")
os.environ.setdefault("STONKS_NO_WARMUP", "1")
