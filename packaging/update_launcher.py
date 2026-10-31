"""Entrypoint for the self-contained Python updater (no shell or system Python)."""
import multiprocessing

if __name__ == '__main__':
    multiprocessing.freeze_support()
    from steve_desktop.windows_update_helper import main
    raise SystemExit(main())
