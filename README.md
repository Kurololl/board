# Board

A collaborative whiteboard that runs entirely on GitHub Pages: drawing, sticky notes, images, folders you can step into, and colored threads that connect related pins.

## Storage modes

The site picks its mode automatically:

| Mode | When it is used | What you get |
|---|---|---|
| **Live (Supabase)** | `SUPABASE_URL` and `SUPABASE_KEY` are set in `app.js` | Changes appear for everyone in about half a second, other people's cursors are visible, no tokens needed |
| **GitHub** | No Supabase keys, site is served from `github.io` | Data is stored as files in your repository, every editor needs their own token |
| **Local only** | Neither of the above | Everything is stored in the browser, useful for testing |

## Setup

### 1. Publish the site

1. Create a **public** repository and upload `index.html`, `style.css` and `app.js`.
2. Go to **Settings → Pages → Source: Deploy from a branch → main / (root)** and click **Save**.
3. After a minute or two the site is available at `https://<username>.github.io/<repository>/`.

GitHub Pages is free for public repositories. Private repositories need a paid plan.

### 2a. Live mode (recommended for working together)

1. Sign up at [supabase.com](https://supabase.com) and create a new project.
2. Open **SQL Editor**, paste the contents of `schema.sql` and click **Run**. This creates the `boards` table, enables realtime and creates the `images` storage bucket.
3. Go to **Project Settings → API** and copy the **Project URL** and the **anon / publishable key**.
4. Put them into the first two lines of `app.js`:

```js
const SUPABASE_URL = "https://xxxx.supabase.co";
const SUPABASE_KEY = "your anon/publishable key";
```

5. Commit the updated `app.js`.

The anon key is public by design and safe to commit. Never put the `service_role` / secret key here.

Notes:
- Anyone who has the link to the site can edit the board.
- Free Supabase projects are paused after a week of inactivity. You can resume them from the dashboard.
- You can type your name in the top-right corner. Others see it next to your cursor.

### 2b. GitHub mode

Board data is stored in a separate `board-data` branch, so saving does not trigger Pages rebuilds:

- `boards/main.json`: the main board
- `boards/<id>.json`: one file per folder
- `images/<id>.webp`: uploaded images

Every save is a commit, so the full history is available in the repository.

#### Creating an access token

GitHub does not give you a token automatically, even if you own the repository. You need to create one:

1. Click your avatar → **Settings** → **Developer settings** (bottom of the left sidebar).
2. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
3. Fill in the form:
   - **Repository access**: *Only select repositories* → pick the board repository.
   - **Permissions → Repository permissions → Contents**: *Read and write*.
4. Click **Generate token** and copy the `github_pat_…` value right away. It is shown only once.
5. Open the site, click ⚙️, paste the token and click **Save**.

The token is stored only in your browser. Do not commit it to the repository, because GitHub will detect and revoke it.

To let other people edit, add them as collaborators (**Settings → Collaborators**). Each of them creates their own token. Without a token the board is read-only.

#### Troubleshooting

**`403 Resource not accessible by personal access token`**: the token cannot write to the repository. Edit the token and check that:
- the board repository is selected under *Repository access*;
- *Contents* is set to *Read and write*.

Updating the token does not change its value, so you only need to reload the page.

If the repository belongs to an organization, an organization owner may need to approve the token.

**Custom domain**: with a custom domain the site cannot detect the repository from the URL. Fill in **Owner** and **Repository** in ⚙️ once.

## Features

### Pins

- **Notes**: press `N`, click 📝 or double-click an empty spot.
- **Images**: press `I`, click 🖼️, drag files onto the board or paste with `Ctrl+V`. Images are compressed to WebP (max 1600 px) before upload. Pasting an image URL creates an image pin without uploading.
- Pasting plain text creates a note.

### Styling

Click a pin to open its toolbar:

- background color (presets or any custom color);
- **A− / A+** for text size;
- **B** for bold (`Ctrl+B`);
- **A** with an underline for text color;
- 🧵 to connect to another pin;
- 🗑️ to delete.

### Threads

Connect related pins like on a detective board:

- use the 🧵 tool (`C`) and drag from one pin to another, or
- click 🧵 on a pin's toolbar, then click the second pin.

Click a thread to change its color or delete it (`Del`). New threads use the last selected color.

### Folders

- Press `F` or click 📁 to create a folder and type its name on the card.
- Double-click the folder or click **Open →** to step inside. Each folder is its own board.
- Drag any pin onto a folder to move it inside.
- The breadcrumb at the top shows where you are (🏠 Home › Ideas › …). Click any part of it to go back, or press `Esc`.
- The 🔗 link opens the current folder directly.

## Controls

| Action | How |
|---|---|
| Pan | ✋ + drag, Space + drag, middle mouse button, two fingers |
| Zoom | Mouse wheel, pinch |
| Select / Pen / Eraser | `V` / `P` / `E` |
| Note | `N`, 📝, double-click on empty space |
| Folder | `F`, 📁 |
| Image | `I`, 🖼️, drag & drop, `Ctrl+V` |
| Connect pins | `C`, then drag from pin to pin |
| Delete selection | `Delete` / `Backspace` |
| Deselect / leave folder | `Esc` |
| Undo | `Ctrl+Z` |
| Save now | `Ctrl+S` |
| Free resize of an image | Hold `Shift` while resizing |

## Limits

- **GitHub mode**: other people's changes appear within about 15 seconds. The recommended repository size is 1 GB.
- **Live mode**, Supabase free tier: 500 MB database, 1 GB file storage, and the project pauses after 7 days of inactivity.
- Deleted pins and images remain in storage and history.
