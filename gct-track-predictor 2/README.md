# Grand Central Track Predictor

Metro-North departures from Grand Central, with a predicted track for every train before it's
posted. Runs entirely on free GitHub services: no server, no API key, no monthly cost.

## One-time setup (about 5 minutes)

1. **Create a public repository** at https://github.com/new (e.g. `gct-tracks`). It has to be *public*,
   because that's what makes GitHub Actions minutes and GitHub Pages free.
2. **Upload these files**: on the empty repo page, click *uploading an existing file* and drag in
   everything inside this folder, **including the hidden `.github` folder**
   (on a Mac, press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>.</kbd> in Finder to show it). Commit.
3. **Turn on Pages**: repo *Settings → Pages → Build and deployment → Source: **GitHub Actions***.
4. **Start it**: *Actions* tab → *Collect tracks & publish site* → *Run workflow*.
   (If Actions asks you to enable workflows first, click the button.)

Your site: `https://<your-username>.github.io/<repo-name>/`. After that it runs by itself.

## What runs automatically

- Every 5 minutes, GitHub runs `collector/collect.js`. For 4 minutes it reads Metro-North's public
  real-time feed every 30 seconds. The feed includes each train's track once it's posted.
- Every track posted at Grand Central is saved to `data/history/YYYY-MM.csv` in the repo:
  date, train #, line, destination, scheduled time, track, and how many minutes before departure
  it was posted.
- It rebuilds the prediction model from the last 180 days and republishes the site.
- On the site, if your browser is allowed to read the MTA feed directly, tracks and delays update live.
  If not, the board uses the latest update from GitHub, which is at most ~5–10 minutes old.

## How predictions work

1. **Same train number**, same kind of day (weekday vs. weekend), with recent days weighted more.
2. With fewer than 3 past days for that train, it also uses **similar departures**: same line, within about 30 minutes.
3. Otherwise it falls back to **the line's overall track mix**.

You get the most likely track, its odds, the runner-ups, and upper vs. lower level odds.
Click a train to see its recent tracks.

**There's no public archive of past Metro-North track assignments**, so history starts the day
you turn this on. Predictions become useful after about two weeks.

## Things to know

- GitHub sometimes starts scheduled runs late during busy periods, so a few tracks may be missed.
  The site still works.
- GitHub pauses scheduled workflows in repos with no activity for 60 days. The bot's own commits
  should keep it active, but if the site stops updating, re-enable the workflow in the *Actions* tab.
- Try it offline: `DEMO=1 node collector/collect.js`, then serve the `site/` folder
  (e.g. `npx serve site`). This uses made-up trains, so delete `site/data` and `data/history` afterward.

## Files

- `.github/workflows/collect.yml`: the schedule
- `collector/collect.js`: polls the feed, logs tracks, writes the site data
- `collector/gtfs-static.js`: reads Metro-North's schedule zip for names, colors and train numbers
- `site/index.html`: the departure board
- `site/lib/gtfsrt.js`: dependency-free decoder for the real-time feed, used by both the collector and the site
- `site/lib/predict.js`: the model

Not affiliated with the MTA. Predictions are guesses, so check the board before you run.
