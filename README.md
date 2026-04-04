# My Catalog Flipbook

A mobile-optimized, landscape flipbook with dark premium design.

## How to customize

### 1. Add your own pages
Open `index.html` and find the `SPREADS` array near the top of the `<script>` block.

Each spread has a `l` (left page) and `r` (right page). You can:

**Option A — use background images (recommended for real catalogs):**
Replace the inline `background:` style with your page image:
```html
<div class="pg" style="background: url('pages/page-01.jpg') center/cover no-repeat;">
```
Export each PDF page as a JPG at 1200×675px (16:9) and put them in a `/pages/` folder.

**Option B — keep HTML content:**
Edit the HTML inside each page div to match your products.

### 2. Change the brand name
Find `<div id="brand">My Catalog &nbsp;·&nbsp; 2025</div>` and update it.

### 3. Add or remove spreads
Add new objects to the `SPREADS` array following the same structure. The dots and navigation update automatically.

## Deploy to Netlify (free)

1. Go to [netlify.com](https://netlify.com) and sign up free
2. Drag and drop the entire `flipbook/` folder onto the Netlify dashboard
3. Your catalog is live instantly with a public URL
4. Optional: connect a custom domain in Netlify settings

## File structure
```
flipbook/
  index.html      ← the entire flipbook (single file)
  netlify.toml    ← Netlify cache config
  pages/          ← put your page images here (create this folder)
    page-01.jpg
    page-02.jpg
    ...
```

## Features
- Touch swipe (left/right) to flip pages
- Keyboard arrow keys to navigate
- Dot navigation — tap any dot to jump to that spread
- Fullscreen button for immersive viewing
- First-visit "how to use" overlay
- Animated loading screen
- Physics-based page flip with shadow/brightness simulation
- Fully responsive — works on any phone, tablet, or desktop
- No dependencies — pure HTML/CSS/JS, no libraries needed
