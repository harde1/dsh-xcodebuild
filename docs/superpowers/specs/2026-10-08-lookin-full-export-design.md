# Lookin: quick / full export, background progress, history

## What the user sees
- `View Hierarchy` reads the tree and writes a **quick** `.lookin` (structure only, no images).
- `Lookin` opens a popup with two choices:
  - **Quick** opens the quick file. If no tree has been read yet, it reads one first.
  - **Full** starts a background export:
    - Views are rendered in batches of 40. The app is stopped only while a batch renders and runs again between batches.
    - Then the images are copied off the device, the archive is written, and it opens in Lookin.
    - Progress is shown as stage + `done/total` + percent.
    - A mini bar in the drawer keeps showing progress when the popup is closed.
    - `Cancel` stops after the batch in hand, releases the app, and writes nothing.
- `History` lists the kept trees, newest first. Each row shows kind, app, time, views, images and size, with `Open` and `Delete`.
- With no Lookin.app installed, the button reads `Reveal` and both exports end in Finder.

## Storage
- Archives go to `~/Library/Caches/dsh-xcodebuild/lookin/`.
- File names are `lookin-<stamp>-quick|full.lookin`, with a `<name>.json` metadata file beside each (kind, app, bundleId, views, images, created).
- Only the newest **3** are kept. Older ones, and orphaned metadata, are pruned on every write and every listing.
- Delete and open accept only names matching `isArchiveName`. That rule is the path-traversal boundary.

## Host ops
- `lookinFull` starts the job; only one runs at a time.
- `lookinJob` returns the job's state; the panel polls it every 0.7 s.
- `lookinCancel` cancels the job.
- `lookinHistory`, `lookinOpenFile` and `lookinDelete` manage the kept files.

The job never waits on the panel. A failure or a cancel calls `releaseApp`; success leaves the app running.

## Units
- `lib/lookin-cache.js` holds the pure rules: names, retention, rows, batches, and percent.
- `lib/view-shots.js` adds a `start`/`limit` window to the render walk. Indexes stay global, and only the first batch clears the directory.
