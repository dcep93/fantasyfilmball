Agent rules for this repo:

- Most app behavior should live in `app/src/app_x`; shared static assets belong in `app/public`.
- Deployment behavior lives in `.github/workflows`; keep those scripts close to the reference architecture unless the Firebase project needs a focused change.
- The app should generally be night mode, modular, with good organization, and files not too big.
- FantasyFilmBall styling should match the colors, font stack, and general UI feel of `multisport420/app/src/app_x/styles/multisport.css` and `multisport420/app/src/index.css`.
- For CSS sizing, prefer `rem` for layout, spacing, widths, heights, radii, and other app-level scale decisions so global resizing stays predictable from the root font size.
- Use `em` for element-local sizing that should track the component's own text, such as icon size, inline spacing, or typography-relative padding.
- Avoid defaulting to `px` unless exact fixed geometry is intentionally required.
