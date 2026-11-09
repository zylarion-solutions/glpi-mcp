# Cómo trabajamos en este repo

Estándar de desarrollo de Zylarion (el mismo de `zylarion-solutions/zylarion-web` y `zylarion-solutions/baas`).

## Ramas

| Rama | Para qué | Cómo se llega |
|---|---|---|
| `main` | Lo que está en producción. Cada merge a `main` debe dejar `main` publicable (npm y la imagen Docker). | Solo por PR |
| `feature/*`, `fix/*`, `security/*`, `chore/*`, `docs/*`, `refactor/*`, `test/*`, `ci/*` | Trabajo | Sale de `main` |

**Nunca se hace push directo a `main`.** Todo entra por Pull Request con el CI en verde
(regla de la rama en GitHub). Merge: squash.

## Ciclo

```bash
git switch main && git pull
git switch -c fix/algo
# … cambios …
npm run ci                       # lo mismo que corre GitHub
git commit -m "fix(alcance): descripción"
git push -u origin fix/algo      # PR → main
```

Títulos de PR en [Conventional Commits](https://www.conventionalcommits.org/es/): `feat`, `fix`,
`security`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, `build`, `revert`, `release`.

## Qué valida cada PR

Este repo sigue el [Estándar QA de Zylarion](https://github.com/zylarion-solutions/estandar-qa) (nivel 2 · público). Como el repo es público, los workflows del estándar están copiados en `.github/workflows/estandar-*.yml` (no se editan aquí). `qa.yml` corre todo y termina en el check **Estándar QA**, el único que exige el ruleset de `main`:

1. Política del PR: rama de origen, título en Conventional Commits y descripción.
2. `npm run ci` en Node 22 y 24: tipos (`tsc`), pruebas (vitest) y build; además `docker build` de la imagen.
3. Seguridad: secretos (gitleaks), integridad y vulnerabilidades de dependencias (`npm audit`) y análisis estático (Semgrep). También cada lunes.
4. CodeQL y revisión de dependencias del PR.
5. Higiene de workflows: actionlint y zizmor.
