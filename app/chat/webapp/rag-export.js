// app/chat/webapp/rag-export.js
//
// Pure helpers for the RAG collection export reassembly path.
// No DOM, no JSZip, no fetch — safe to import from Jest.
//
// Loaded in the browser as <script> (attaches window.RagExport) and
// required from Jest in test/unit/rag-export.test.ts.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RagExport = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function groupKey(metadata) {
    const source = metadata && metadata.source;
    if (!source) return null;
    const uploadId = (metadata && metadata.uploadId) || '_legacy';
    // JSON-encode so any character in `source` (e.g. `|`) is unambiguous.
    return JSON.stringify([source, uploadId]);
  }

  function groupChunksBySource(docs) {
    const groups = new Map();
    const orphans = [];
    for (const doc of docs) {
      const md = doc && doc.metadata;
      const key = groupKey(md);
      const idx = md && md.chunkIndex;
      if (!key || !Number.isInteger(idx)) {
        orphans.push(doc);
        continue;
      }
      let entry = groups.get(key);
      if (!entry) {
        entry = {
          source: md.source,
          uploadId: md.uploadId || '_legacy',
          docs: [],
          warnings: [],
        };
        groups.set(key, entry);
      }
      entry.docs.push(doc);
    }
    for (const entry of groups.values()) {
      entry.docs.sort(
        (a, b) => a.metadata.chunkIndex - b.metadata.chunkIndex,
      );

      // Preserve the old integrity checks, but attach warnings to this
      // upload-specific entry instead of warningsBySource.
      const seen = new Set();
      for (const d of entry.docs) {
        const i = d.metadata.chunkIndex;
        if (seen.has(i)) {
          entry.warnings.push('⚠ ' + entry.source + ': duplicate chunk index ' + i);
        }
        seen.add(i);
      }

      const present = new Set(entry.docs.map((d) => d.metadata.chunkIndex));
      const max = Math.max(...entry.docs.map((d) => d.metadata.chunkIndex));
      const missing = [];
      for (let i = 0; i <= max; i += 1) if (!present.has(i)) missing.push(i);
      if (missing.length) {
        entry.warnings.push(
          '⚠ ' + entry.source + ': ' + missing.length + ' chunks missing (indices ' + missing.join(',') + ')',
        );
      }

      const totals = Array.from(
        new Set(
          entry.docs
            .map((d) => d.metadata.totalChunks)
            .filter((v) => Number.isInteger(v)),
        ),
      );
      if (totals.length > 1) {
        entry.warnings.push(
          '⚠ ' + entry.source + ': inconsistent totalChunks (' + totals.join(' vs ') + ')',
        );
      } else if (totals.length === 1 && totals[0] !== entry.docs.length) {
        entry.warnings.push(
          '⚠ ' + entry.source + ': expected ' + totals[0] + ' chunks, found ' + entry.docs.length,
        );
      }
    }
    return { groups, orphans };
  }
  function safeSourceExportName(sourceName, used) {
    const raw = String(sourceName == null ? '' : sourceName);

    // Strip directory components: last segment after the rightmost / or \
    const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    let leaf = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;

    // Reject pure-dot leftovers (".", "..") — they have no real name
    if (leaf === '' || leaf === '.' || leaf === '..') {
      leaf = '';
    }

    // Split extension off (.md / .txt / .json / .markdown / etc.).
    // Preserve everything after the final dot as the extension when the
    // dot is neither first nor last.
    let base = leaf;
    let ext = '';
    const dot = leaf.lastIndexOf('.');
    if (dot > 0 && dot < leaf.length - 1) {
      base = leaf.slice(0, dot);
      ext = '.' + leaf.slice(dot + 1);
    }

    // Sanitize basename: replace each unsafe character with underscore individually
    base = base.replace(/[^A-Za-z0-9._-]/g, '_');
    ext = ext.replace(/[^A-Za-z0-9.]+/g, '');

    // Truncate basename to the same practical limit safeExportName uses (120 chars)
    if (base.length > 120) base = base.slice(0, 120);

    if (!base) return 'source.txt';

    let candidate = base + ext;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    let n = 1;
    while (used.has(base + '-' + n + ext)) n += 1;
    candidate = base + '-' + n + ext;
    used.add(candidate);
    return candidate;
  }
  function reassembleSource(group, safeName, uploadId, warnings) {
    if (!Array.isArray(group) || group.length === 0) {
      throw new Error('reassembleSource: group cannot be empty');
    }
    const docs = group.slice().sort(
      (a, b) =>
        ((a.metadata && a.metadata.chunkIndex) || 0) -
        ((b.metadata && b.metadata.chunkIndex) || 0),
    );
    const body = docs.map((d) => d.text).join('\n\n');
    const description =
      docs[0] && docs[0].metadata && docs[0].metadata.description;
    const totalChunks =
      docs[0] && docs[0].metadata && docs[0].metadata.totalChunks;
    const createdAt = docs.reduce((min, d) => {
      const cur = d.createdAt;
      if (!cur) return min;
      return !min || cur < min ? cur : min;
    }, null);
    const provenance = {
      source: docs[0].metadata.source,
      exportName: safeName,
    };
    if (uploadId) provenance.uploadId = uploadId;
    if (description) provenance.description = description;
    if (typeof totalChunks === 'number') provenance.totalChunks = totalChunks;
    provenance.reassembledFrom = docs.map((d) => d.id);
    if (createdAt) provenance.createdAt = createdAt;
    // Sidecar always carries a `warnings` array (possibly empty) — preserves
    // the pre-existing #89 contract that downstream tests assert against.
    provenance.warnings = warnings ? warnings.slice() : [];
    return {
      name: safeName,
      body,
      sidecar: {
        name: safeName + '.meta.json',
        body: JSON.stringify(provenance, null, 2),
      },
    };
  }
  return { groupChunksBySource, safeSourceExportName, reassembleSource, groupKey };
});
