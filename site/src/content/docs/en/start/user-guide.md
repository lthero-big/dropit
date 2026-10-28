---
title: User guide
---

## Spaces and items

- Every account automatically gets a **private space**; spaces you join through an invitation are **shared spaces**.
- Paste or type text in the input box to send it; drag and drop, paste, or pick files to upload them.
- New items appear in real time via WebSocket on every device in the same space; “Online” in the sidebar shows the number of connections on the current channel.
- Each item shows its source device (for example `Mac · Chrome`, `cli`).
- Items expire automatically after the retention period (168 hours by default, adjustable by admins).

## Editing and organizing

- **Edit**: text items can be edited in place; edits sync to the space and the creation time stays the same (in a space only the author can edit; in a temporary room anyone with the link can edit).
- **Render**: when content looks like Markdown you can switch to “Render”, which only shows headings, lists, quotes, code, emphasis and http/https links — HTML is not parsed and images are not embedded.
- **Tags**: up to 8 per item; click a tag to filter, and the search box matches tags too.
- **Pin**: pinned items are listed first.
- **Groups**: up to 24 named groups per space; deleting a group does not delete its items, they just become “Ungrouped”.
- **Command palette**: Ctrl/⌘ K, jump by text, file name or tag.

## Files

- Images show a thumbnail; opening one shows a preview whose longest side is 2048px. Download to get the original.
- Video and audio play inline (with seeking) once the server has confirmed the type from the file header.
- Downloads are resumable; the web app automatically uses chunked upload for files larger than the chunk size, and interrupted uploads can be resumed.

## Share links

The item's author or the space owner can create a read-only link for a single item:

- Validity: 1 hour / 1 day / 7 days / never expires; views: once, a fixed number (up to 100) or unlimited.
- The public page `/s/<token>` needs no sign-in; links can be revoked at any time.
- Even a “never expires” link cannot outlive the item: it stops working when the item expires, is retracted, or its room is closed.
- Links are capabilities: anyone who has the URL can view the content.

## Temporary rooms

- Click “Enter a temporary room” on the login page to create one — no account needed; anyone holding the room link can read, write, share and retract.
- A room lives for at most 24 hours and has lower limits than a private space (by default 5 MiB per file, 50 MiB in total).
- The room page can show a QR code of the current address so another device can join by scanning it (the QR code only contains the room address, not the session).

## Settings

The `/settings` page manages personal access tokens (for the CLI and scripts). Under “Signed-in devices” you can see every device that has signed in, sign out a single device or sign out all other devices at once; signed-out devices are invalidated immediately. Click “N online” in the top bar to see online devices. The approval page for CLI device-code login is `/device`.
