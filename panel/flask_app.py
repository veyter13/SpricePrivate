import sys

project_home = '/home/keyadmin/mysite'
if project_home not in sys.path:
    sys.path = [project_home] + sys.path

from sprice_panel import app as application  # noqa
