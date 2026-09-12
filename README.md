# Домашка

## Порядок настройки с нуля

1. В Supabase (SQL Editor) выполни по очереди:
   - `sql/1_schema.sql`
   - `sql/2_migration_roster.sql`
2. Создай первую группу и список студентов (см. чат с Claude — команды `insert into groups...` и `insert into roster...`).
3. Назначь себя владельцем (`is_owner = true`) в таблице `profiles` после первого входа через `auth.html`.
4. В GitHub: Settings → Secrets and variables → Actions → New repository secret:
   `SUPABASE_SERVICE_ROLE_KEY` = твой service_role ключ из Supabase (Project Settings → API).
5. Во вкладке Actions запусти workflow "Update schedule" вручную (Run workflow), проверь что расписание подтянулось.

## Файлы

- `auth.html` — вход/регистрация (группа + ФИО, сверка со списком).
- `index_3_updated.html` — само приложение (расписание/домашка).
- `scripts/scrape-schedule.js` — скрапер расписания с сайта универа в Supabase.
- `.github/workflows/update-schedule.yml` — автозапуск скрапера по расписанию.
- `sql/` — SQL для настройки базы (выполняется один раз в Supabase SQL Editor, в репозитории — для истории/справки).
