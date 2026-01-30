use git2::Repository;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Serialize, Clone)]
pub struct SavedRepo {
    pub name: String,
    pub path: String,
    pub last_opened: i64,
}

fn open_db<R: Runtime>(app: &AppHandle<R>) -> Result<Connection, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let db_path = data_dir.join("repos.sqlite");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS repos (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            last_opened INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn save_repo<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    path: &str,
    last_opened: i64,
) -> Result<(), String> {
    Repository::open(path).map_err(|_| "Repository not found".to_string())?;
    let conn = open_db(app)?;
    conn.execute(
        "INSERT INTO repos (path, name, last_opened)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET
            name = excluded.name,
            last_opened = excluded.last_opened",
        params![path, name, last_opened],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_repos<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<SavedRepo>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare("SELECT name, path, last_opened FROM repos ORDER BY last_opened DESC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(SavedRepo {
                name: row.get(0)?,
                path: row.get(1)?,
                last_opened: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut repos = Vec::new();
    let mut stale_paths = Vec::new();
    for row in rows {
        let repo = row.map_err(|e| e.to_string())?;
        if Repository::open(&repo.path).is_ok() {
            repos.push(repo);
        } else {
            stale_paths.push(repo.path);
        }
    }

    if !stale_paths.is_empty() {
        let mut delete_stmt = conn
            .prepare("DELETE FROM repos WHERE path = ?1")
            .map_err(|e| e.to_string())?;
        for path in stale_paths {
            delete_stmt.execute(params![path]).map_err(|e| e.to_string())?;
        }
    }

    Ok(repos)
}
