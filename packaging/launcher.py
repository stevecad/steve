import runpy
import sys

sys.dont_write_bytecode = True

runpy.run_module("steve_desktop.app", run_name="__main__")
