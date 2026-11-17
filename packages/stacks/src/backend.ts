import type { StackTemplate } from "./types.js";

const PAGE_CSS = `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}

body {
  margin: 0;
}

main {
  max-width: 48rem;
  margin: 0 auto;
  padding: 2rem 1rem;
}
`;

export const fastapiStack: StackTemplate = {
  id: "fastapi",
  name: "FastAPI",
  language: "python",
  runtime: "server",
  description: "A Python web API with FastAPI, with optional server-rendered pages. Best for APIs and data-centric backends.",
  beta: true,
  sandbox: {
    image: "python:3.13-slim",
    install: "pip install --user --quiet -r requirements.txt",
    installTriggers: ["requirements.txt"],
    dev: "python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload",
    port: 8000,
    hotReload: true,
    check: "python -m compileall -q . -x '(\\.venv|node_modules)'",
  },
  guidance: `- The application object is \`app\` in main.py. Group further routes in modules and include them with APIRouter.
- Keep GET /health: deployments call it as health check.
- HTML pages are Jinja2 templates in templates/; static files live in static/.
- New packages go into requirements.txt with a version range; they are installed automatically.
- Read configuration from os.environ. If the app needs a database, add a postgres resource to lotse.yaml and read DATABASE_URL.`,
  files: ({ name, title }) => ({
    "lotse.yaml": `version: 1\nname: ${name}\nruntime:\n  kind: server\n  language: python\n  version: "3.13"\n  port: 8000\n  start: uvicorn main:app --host 0.0.0.0 --port $PORT\n  healthcheck: /health\nbuild:\n  strategy: auto\n`,
    "requirements.txt": "fastapi>=0.163,<1\nuvicorn[standard]>=0.54,<1\njinja2>=3.1,<4\n",
    "main.py": `from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).parent

app = FastAPI(title="${title}")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(request, "index.html", {"title": "${title}"})
`,
    "templates/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ title }}</title>
    <link rel="stylesheet" href="/static/styles.css">
  </head>
  <body>
    <main>
      <h1>{{ title }}</h1>
      <p>Your app starts here.</p>
    </main>
  </body>
</html>
`,
    "static/styles.css": PAGE_CSS,
    ".gitignore": "__pycache__/\n.venv/\n*.pyc\n.env\n",
    "README.md": `# ${title}\n\nA FastAPI app.\n\n\`\`\`sh\npip install -r requirements.txt\nuvicorn main:app --reload\n\`\`\`\n\nDeploy with \`lotse deploy\`.\n`,
  }),
};

export const djangoStack: StackTemplate = {
  id: "django",
  name: "Django",
  language: "python",
  runtime: "server",
  description: "A Python web framework with ORM, admin and server-rendered pages. Best for database-driven apps with forms and user accounts.",
  beta: true,
  sandbox: {
    image: "python:3.13-slim",
    install: "pip install --user --quiet -r requirements.txt && python manage.py migrate --noinput",
    installTriggers: ["requirements.txt"],
    dev: "python manage.py runserver 0.0.0.0:8000",
    port: 8000,
    hotReload: true,
    check: "python manage.py check",
  },
  guidance: `- The project package is config/ (settings, urls, wsgi). App code lives in the app pages/; create further apps only when the domain calls for it and add them to INSTALLED_APPS.
- Keep the /health/ route: deployments call it as health check.
- After changing models, create migrations with \`python manage.py makemigrations\`. They are applied on deployment by the release command in lotse.yaml.
- Templates are in pages/templates/pages/, static files in pages/static/.
- Settings read SECRET_KEY, DEBUG, ALLOWED_HOSTS and DATABASE_URL from the environment; do not hard-code them.`,
  files: ({ name, title }) => ({
    "lotse.yaml": `version: 1\nname: ${name}\nruntime:\n  kind: server\n  language: python\n  version: "3.13"\n  port: 8000\n  start: gunicorn config.wsgi --bind 0.0.0.0:$PORT\n  healthcheck: /health/\nbuild:\n  strategy: auto\nrelease:\n  command: python manage.py migrate --noinput\nresources:\n  - type: postgres\n    name: db\nenv:\n  secrets:\n    - SECRET_KEY\n`,
    "requirements.txt": "Django>=6.1,<7\ngunicorn>=27,<28\nwhitenoise>=6.12,<7\ndj-database-url>=3.1,<4\npsycopg[binary]>=3.3,<4\n",
    "manage.py": `#!/usr/bin/env python
import os
import sys


def main() -> None:
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
`,
    "config/__init__.py": "",
    "config/settings.py": `import os
from pathlib import Path

import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent

# Development falls back to an insecure key; deployments must set SECRET_KEY.
SECRET_KEY = os.environ.get("SECRET_KEY", "dev-only-not-a-secret")
DEBUG = os.environ.get("DEBUG", "1" if "SECRET_KEY" not in os.environ else "0") == "1"
ALLOWED_HOSTS = os.environ.get("ALLOWED_HOSTS", "*").split(",")
CSRF_TRUSTED_ORIGINS = [o for o in os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(",") if o]
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "pages",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {"default": dj_database_url.config(default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}", conn_max_age=600)}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage" if not DEBUG else "django.contrib.staticfiles.storage.StaticFilesStorage"},
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
`,
    "config/urls.py": `from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include("pages.urls")),
]
`,
    "config/wsgi.py": `import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

application = get_wsgi_application()
`,
    "pages/__init__.py": "",
    "pages/apps.py": `from django.apps import AppConfig


class PagesConfig(AppConfig):
    name = "pages"
`,
    "pages/models.py": "from django.db import models  # noqa: F401\n\n# Models of the app go here.\n",
    "pages/migrations/__init__.py": "",
    "pages/urls.py": `from django.urls import path

from . import views

urlpatterns = [
    path("", views.index, name="index"),
    path("health/", views.health, name="health"),
]
`,
    "pages/views.py": `from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import render


def index(request: HttpRequest) -> HttpResponse:
    return render(request, "pages/index.html", {"title": "${title}"})


def health(request: HttpRequest) -> JsonResponse:
    return JsonResponse({"status": "ok"})
`,
    "pages/templates/pages/index.html": `{% load static %}<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ title }}</title>
    <link rel="stylesheet" href="{% static 'pages/styles.css' %}">
  </head>
  <body>
    <main>
      <h1>{{ title }}</h1>
      <p>Your app starts here.</p>
    </main>
  </body>
</html>
`,
    "pages/static/pages/styles.css": PAGE_CSS,
    ".gitignore": "__pycache__/\n.venv/\n*.pyc\n.env\ndb.sqlite3\nstaticfiles/\n",
    "README.md": `# ${title}\n\nA Django app.\n\n\`\`\`sh\npip install -r requirements.txt\npython manage.py migrate\npython manage.py runserver\n\`\`\`\n\nDeploy with \`lotse deploy\`.\n`,
  }),
};

export const goStack: StackTemplate = {
  id: "go-nethttp",
  name: "Go net/http",
  language: "go",
  runtime: "server",
  description: "A Go web server using only the standard library, with HTML templates. Best for small, fast services with few dependencies.",
  beta: true,
  sandbox: {
    image: "golang:1.27-alpine",
    install: "go mod download",
    installTriggers: ["go.mod"],
    dev: "go run .",
    port: 8080,
    hotReload: false,
    check: "go vet ./...",
  },
  guidance: `- Use only the Go standard library unless a dependency is clearly necessary.
- Handlers are registered on the ServeMux in main.go; split them into further files of package main as the app grows.
- Keep GET /health: deployments call it as health check.
- HTML templates are in templates/ and parsed with html/template; static files are served from static/.
- The server listens on the port from the PORT environment variable (default 8080).`,
  files: ({ name, title }) => ({
    "lotse.yaml": `version: 1\nname: ${name}\nruntime:\n  kind: server\n  language: go\n  version: "1.27"\n  port: 8080\n  healthcheck: /health\nbuild:\n  strategy: auto\n`,
    "go.mod": `module ${name}\n\ngo 1.27\n`,
    "main.go": `package main

import (
	"html/template"
	"log"
	"net/http"
	"os"
)

var templates = template.Must(template.ParseGlob("templates/*.html"))

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(\`{"status":"ok"}\`))
	})
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.Dir("static"))))
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		if err := templates.ExecuteTemplate(w, "index.html", map[string]string{"Title": "${title}"}); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("listening on %s", port)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}
`,
    "templates/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ .Title }}</title>
    <link rel="stylesheet" href="/static/styles.css">
  </head>
  <body>
    <main>
      <h1>{{ .Title }}</h1>
      <p>Your app starts here.</p>
    </main>
  </body>
</html>
`,
    "static/styles.css": PAGE_CSS,
    ".gitignore": "/app\n.env\n",
    "README.md": `# ${title}\n\nA Go web server on the standard library.\n\n\`\`\`sh\ngo run .\n\`\`\`\n\nDeploy with \`lotse deploy\`.\n`,
  }),
};

export const laravelStack: StackTemplate = {
  id: "laravel",
  name: "Laravel",
  language: "php",
  runtime: "container",
  description: "A PHP framework with routing, ORM and Blade templates. Best for classic database-driven web apps.",
  beta: true,
  sandbox: {
    image: "composer:2",
    // Composer downloads packages as archives from GitHub.
    allowedHosts: ["api.github.com", "codeload.github.com", "github.com"],
    install:
      "composer install --no-interaction --prefer-dist --quiet && ([ -f .env ] || (cp .env.example .env && php artisan key:generate --quiet)) && touch database/database.sqlite && php artisan migrate --force --quiet",
    installTriggers: ["composer.json"],
    dev: "php artisan serve --host 0.0.0.0 --port 8000",
    port: 8000,
    hotReload: true,
    check: "php artisan route:list --json > /dev/null",
  },
  bootstrap:
    "composer create-project --no-interaction --prefer-dist --no-scripts laravel/laravel /tmp/lotse-laravel && cp -a /tmp/lotse-laravel/. . && rm -rf /tmp/lotse-laravel",
  guidance: `- This is a standard Laravel project. Routes are in routes/web.php, controllers in app/Http/Controllers, views are Blade templates in resources/views, models in app/Models.
- Keep the /up route Laravel ships: deployments call it as health check.
- Create database changes as migrations with \`php artisan make:migration\`; they are applied on deployment by the release command in lotse.yaml.
- Keep the Dockerfile: it is how the app is built for deployment.
- Read configuration through config() and env(); secrets are declared under env.secrets in lotse.yaml.`,
  files: ({ name }) => ({
    "lotse.yaml": `version: 1\nname: ${name}\nruntime:\n  kind: container\n  language: php\n  port: 8080\n  healthcheck: /up\nbuild:\n  strategy: dockerfile\nrelease:\n  command: php artisan migrate --force\nresources:\n  - type: postgres\n    name: db\nenv:\n  public:\n    APP_ENV: production\n    APP_DEBUG: "false"\n    DB_CONNECTION: pgsql\n    LOG_CHANNEL: stderr\n  secrets:\n    - APP_KEY\n`,
    Dockerfile: `FROM composer:2 AS vendor
WORKDIR /app
COPY . .
RUN composer install --no-dev --optimize-autoloader --no-interaction --ignore-platform-reqs

FROM dunglas/frankenphp:1-php8.4
WORKDIR /app
RUN install-php-extensions pdo_pgsql pdo_sqlite opcache intl
COPY --from=vendor /app /app
RUN chown -R www-data:www-data storage bootstrap/cache
ENV SERVER_NAME=:8080
EXPOSE 8080
CMD ["sh", "-c", "DB_URL=$DATABASE_URL exec frankenphp php-server --root public --listen :8080"]
`,
    ".dockerignore": "vendor/\nnode_modules/\n.env\n.git/\nstorage/logs/*\ndatabase/database.sqlite\n",
  }),
};
