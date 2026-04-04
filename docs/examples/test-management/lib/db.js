/**
 * SQLite storage for test mappings.
 * Maps external references (JIRA issue) to SAP test objects.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'tests.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_mapping (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jira_issue TEXT,
        object_name TEXT NOT NULL,
        object_type TEXT NOT NULL DEFAULT 'CLAS',
        destination TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        draft_source TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mapping_object
        ON test_mapping(object_name, destination);
      CREATE INDEX IF NOT EXISTS idx_mapping_jira
        ON test_mapping(jira_issue);
    `);
  }
  return db;
}

function findByObject(objectName, destination) {
  return getDb().prepare(
    'SELECT * FROM test_mapping WHERE object_name = ? AND destination = ?',
  ).get(objectName, destination);
}

function findByJira(jiraIssue) {
  return getDb().prepare(
    'SELECT * FROM test_mapping WHERE jira_issue = ?',
  ).all(jiraIssue);
}

function upsert({ objectName, objectType, destination, jiraIssue, status, draftSource }) {
  const existing = findByObject(objectName, destination);
  if (existing) {
    getDb().prepare(`
      UPDATE test_mapping
      SET status = COALESCE(?, status),
          jira_issue = COALESCE(?, jira_issue),
          draft_source = COALESCE(?, draft_source),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(status || null, jiraIssue || null, draftSource || null, existing.id);
    return { ...existing, status: status || existing.status, jira_issue: jiraIssue || existing.jira_issue };
  }

  const result = getDb().prepare(`
    INSERT INTO test_mapping (object_name, object_type, destination, jira_issue, status, draft_source)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(objectName, objectType || 'CLAS', destination, jiraIssue || null, status || 'unknown', draftSource || null);

  return { id: result.lastInsertRowid, object_name: objectName, destination, status: status || 'unknown' };
}

function updateStatus(objectName, destination, status) {
  getDb().prepare(`
    UPDATE test_mapping SET status = ?, updated_at = datetime('now')
    WHERE object_name = ? AND destination = ?
  `).run(status, objectName, destination);
}

function listAll() {
  return getDb().prepare('SELECT * FROM test_mapping ORDER BY updated_at DESC').all();
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { findByObject, findByJira, upsert, updateStatus, listAll, close };
