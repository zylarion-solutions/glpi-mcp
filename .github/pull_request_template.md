## Qué cambia

<!-- Una o dos frases. -->

## Por qué

## Definición de terminado (Estándar QA)

- [ ] `npm run ci` (o el equivalente del repo) pasa en local y el check **Estándar QA** está en verde.
- [ ] Lo nuevo trae pruebas; si es un fix, una prueba que falla sin el arreglo.
- [ ] Sin secretos, tokens ni datos personales en código, pruebas o logs.
- [ ] Entradas del usuario validadas en el servidor, no solo en el navegador.
- [ ] Docs, ADR o CONTRIBUTING al día si cambió cómo se usa o se opera algo.
- [ ] Me revisé el diff completo antes de pedir merge.

## Tipo

- [ ] feat · nueva funcionalidad
- [ ] fix · corrección
- [ ] security · endurecimiento o corrección de seguridad
- [ ] chore / docs / ci / refactor

## Checklist del repo

- [ ] No hay secretos, tokens ni datos personales en el código, los logs ni las pruebas.
- [ ] Las herramientas nuevas validan su entrada con zod y tienen prueba.
- [ ] Ningún token de GLPI aparece en logs ni en mensajes de error.

## Cómo lo probé

- [ ] `npm run ci` pasa en local
