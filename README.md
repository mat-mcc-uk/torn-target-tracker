# Torn Target Tracker

A Tampermonkey userscript for identifying and tracking mug targets in Torn City. Uses TornStats spy data to compare battle stats, tracks your attack history per target, and surfaces signals about whether a target is likely holding significant cash right now.

## What it does

**Panel** (home page, floating): ranked list of your saved targets sorted by a combined score. Each row shows the overall score, status icon, spy stats, mug cooldown timer, and the top wallet signal.

**Profile overlay** (any player profile): injected card showing spy data vs your own stats, a plain-English combat assessment, fight record, cash history, variance, trend, and the full list of wallet signals.

**Attack capture** (attack result pages): silently records outcome, cash taken, and respect after each fight. Cash history accumulates automatically - you never log anything manually.

## Scoring

Two independent scores, both 0–100:

**Beatable score**: uses TornStats spy data when available (real strength/defense/speed/dexterity totals), blended with your actual win rate once you have 5+ fights on record. Falls back to level-based estimation when no spy data exists.

**Cash score**: combines level, your historical average cash taken from this target, activity recency, and live situation signals (returning traveller, hospital status, mug protection).

Combined score = beatable × 0.55 + cash × 0.45.

## Wallet signals

The script surfaces these on every profile overlay and as a compact chip in the panel list:

- **✈️ Returning to Torn** - player is in transit back to Torn right now. Strong signal: can't bank mid-flight.
- **🛡 Mug protection active** - you hit this target within the last 12 hours. Their remaining wallet is protected; score is quartered until expiry.
- **🏥 Releasing in ~Nm** - hospitalised but releasing within 60 minutes. They've been sitting with cash they couldn't bank.
- **💰 Consistent carrier** - low variance across your recorded wins. Reliable returns.
- **🎲 Erratic** - high variance. Sometimes $0, sometimes big. Roll of the dice.
- **📈/📉 Cash trending** - recent hits returning 25%+ more or less than the historical baseline. Catches habit changes.
- **⚠️ Low yield - likely 7★ clothing** - average below $200k on a high-level target. The 75% mug reduction is almost certainly active. Not worth the energy.

## Requirements

- Tampermonkey (Chrome, Firefox, Edge) or Violentmonkey
- A Torn API key, Limited Access minimum (for your own battle stats and attack log)
- A TornStats API key (free at tornstats.com - needed for spy data on targets)

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Click the raw link below and Tampermonkey will prompt to install:

```
https://raw.githubusercontent.com/mat-mcc-uk/torn-target-tracker/main/torn-target-tracker.user.js
```

3. Navigate to any Torn page
4. Open the panel (bottom right), expand settings with the gear icon
5. Enter your Torn API key and TornStats API key, click Save keys - the script tests the Torn key before storing it
6. The script seeds your last 100 attacks from the log in the background (8 seconds after page load)

## API key requirements

**Torn API - Limited Access minimum.** This is needed for:
- `battlestats` - your own strength/defense/speed/dexterity (used as the comparison baseline)
- `attacksfull` - your recent attack log (seeds fight history on first load)
- `profile` - target profiles when you visit them or refresh manually

If battlestats aren't accessible the beatable score falls back to level-based estimation, which is much less accurate. Check your key access level at torn.com/preferences.php#tab=api.

**TornStats API - free account.** Sign up at tornstats.com, find your API key in account settings. The script respects TornStats' 1-call-per-hour rate limit by caching spy data for 6 hours.

## Usage notes

**Seeding**: the attack log seeds your last 100 attacks automatically. This gives you instant fight history for anyone you've hit recently without manual setup. Cash taken from those historical attacks is not in the log (Torn's API doesn't expose it), so cash figures start at zero and accumulate from live use.

**Mug protection**: after a successful mug, Torn protects the remaining wallet amount for 12 hours. The script detects this from your own attack record and penalises the cash score heavily. You'll still see the target in the list but the signal will say how long protection has left.

**Returning traveller timing**: this signal requires a live profile refresh to be current. Open the target's profile page or click Refresh Status in the overlay - the script then fetches their current status and shows remaining flight time if they're inbound.

**Spy data age**: TornStats records spy data whenever a TornStats user views a profile. Popular targets refresh often; obscure ones may have weeks-old data. The script shows the age next to every stat total and discounts the beatable score for stale readings (30-day and 60-day thresholds).

**7★ clothing**: targets wearing 7-star clothing get a 75% mug reduction - you take 25% of what you'd otherwise get. The script flags this when your cash history shows consistently low returns on a high-level target. There's no direct way to detect clothing externally; the flag is inference from observed patterns.

## Known limitations

This script is early in its testing. A few things are likely to need adjustment after real-world use:

- **Attack result capture** uses CSS selectors guessed from Torn's class naming. If Torn's attack result page uses different element names, cash and respect won't be recorded automatically. The panel and scoring still work; cash just won't populate until this is fixed.
- **Profile overlay injection** tries several selectors to find an anchor point. It may inject in an unusual position on some profile layouts.
- **Returning traveller detection** reads `status.description` for "Torn". If the API returns a different string (e.g. "Heading home"), the signal won't fire.

Report issues or share the actual DOM element names you see if something isn't working: it's straightforward to patch once the real selectors are known.

## Related scripts

[Foreign Stock Itinerary](https://github.com/mat-mcc-uk/torn-stock-itinerary) - ranks foreign shop items by profit per hour and predicts restock times.

## License

MIT
