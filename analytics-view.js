// The Analytics view's DOM. Browser only: the logic worth testing lives in
// analytics.js and api/_ga-reports.js, and this module turns their results
// into elements.
//
// Every string that came from GA or the database — titles, countries,
// languages, categories — goes in through textContent. They are untrusted.

import {
    rangeBounds, commentsInRange, buildMovieRows,
    formatCompact, formatCount, formatPercent, formatDuration
} from './analytics.js';

// Where each setup step is done, shown when the endpoint is not configured.
const SETUP_STEPS = [
    {
        text: 'Copy the numeric Property ID from GA4 → Admin → Property details (not the G-… measurement ID).',
        link: { label: 'Google Analytics', href: 'https://analytics.google.com/' }
    },
    {
        text: 'Enable the Google Analytics Data API in project movie-recap-1306e.',
        link: { label: 'Enable the API', href: 'https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com?project=movie-recap-1306e' }
    },
    {
        text: 'Create a service account and download a JSON key for it.',
        link: { label: 'Service accounts', href: 'https://console.cloud.google.com/iam-admin/serviceaccounts?project=movie-recap-1306e' }
    },
    { text: "Add the service account's email in GA4 → Admin → Property access management, with the Viewer role." },
    { text: "Set GA_PROPERTY_ID and GA_SERVICE_ACCOUNT_KEY — the key file base64-encoded on one line: base64 -i key.json | tr -d '\\n' — in .env and in Vercel's environment variables, then restart the dev server." }
];

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    return node;
}

// "2026-09-01" is a calendar date, so it is formatted in UTC: in a timezone west
// of UTC, local time would turn it into August 31.
const shortDateFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDateFormat = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const asDate = (iso) => new Date(`${iso}T00:00:00Z`);
const shortDate = (iso) => shortDateFormat.format(asDate(iso));
const longDate = (iso) => longDateFormat.format(asDate(iso));

// The smallest clean maximum at or above the value, chosen so the middle tick
// (half of it) is a whole number too. Finer steps keep the line from using only
// half the plot: a peak of 228 gets 300, not 400. Below 10, a step of 3 would
// put the middle tick on 1.5, so small values use even steps only.
function niceMax(value) {
    const power = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
    const steps = power >= 10 ? [1, 2, 3, 4, 5, 6, 8, 10] : [1, 2, 4, 6, 8, 10];
    for (const step of steps) {
        if (step * power >= value) return step * power;
    }
    return 10 * power;
}

function lineChart(points) {
    const W = 720;
    const H = 220;
    const pad = { top: 16, right: 56, bottom: 28, left: 44 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    const max = niceMax(Math.max(...points.map((point) => point.activeUsers), 1));
    const last = points.length - 1;
    const x = (i) => pad.left + (last === 0 ? plotW / 2 : (i / last) * plotW);
    const y = (value) => pad.top + plotH - (value / max) * plotH;

    const wrap = el('div', 'line-chart');
    const chart = svg('svg', {
        viewBox: `0 0 ${W} ${H}`,
        role: 'img',
        'aria-label': `Daily active users from ${longDate(points[0].date)} to ${longDate(points[last].date)}`
    });

    // Recessive 1px grid at clean ticks; a tick at half is skipped when max is 1.
    const ticks = max > 1 ? [0, max / 2, max] : [0, max];
    for (const tick of ticks) {
        chart.append(svg('line', { class: 'chart-grid', x1: pad.left, x2: pad.left + plotW, y1: y(tick), y2: y(tick) }));
        const label = svg('text', { class: 'chart-tick', x: pad.left - 8, y: y(tick) + 4, 'text-anchor': 'end' });
        label.textContent = formatCompact(tick);
        chart.append(label);
    }
    for (const [i, anchor] of [[0, 'start'], [last, 'end']]) {
        const label = svg('text', { class: 'chart-tick', x: x(i), y: H - 8, 'text-anchor': anchor });
        label.textContent = shortDate(points[i].date);
        chart.append(label);
    }

    const line = points.map((point, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(point.activeUsers).toFixed(1)}`).join(' ');
    chart.append(svg('path', { class: 'chart-area', d: `${line} L${x(last).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` }));
    chart.append(svg('path', { class: 'chart-line', d: line }));

    // The end: a ringed dot and its value, the one label on the line.
    chart.append(svg('circle', { class: 'chart-dot', cx: x(last), cy: y(points[last].activeUsers), r: 4 }));
    const endLabel = svg('text', { class: 'chart-end-label', x: x(last) + 10, y: y(points[last].activeUsers) + 4 });
    endLabel.textContent = formatCompact(points[last].activeUsers);
    chart.append(endLabel);

    const crosshair = svg('line', { class: 'chart-crosshair', y1: pad.top, y2: pad.top + plotH, visibility: 'hidden' });
    const marker = svg('circle', { class: 'chart-dot', r: 4, visibility: 'hidden' });
    // The hit area is the whole plot, never the 2px line: readers aim at a day.
    const hit = svg('rect', {
        class: 'chart-hit', x: pad.left, y: pad.top, width: plotW, height: plotH, tabindex: 0,
        'aria-label': 'Daily active users. Use the left and right arrow keys to read each day.'
    });
    chart.append(crosshair, marker, hit);

    const tooltip = el('div', 'chart-tooltip');
    tooltip.hidden = true;
    wrap.append(chart, tooltip);

    let index = last;
    const showAt = (i) => {
        index = Math.max(0, Math.min(last, i));
        const px = x(index);
        const py = y(points[index].activeUsers);
        for (const [name, value] of [['x1', px], ['x2', px], ['visibility', 'visible']]) crosshair.setAttribute(name, String(value));
        for (const [name, value] of [['cx', px], ['cy', py], ['visibility', 'visible']]) marker.setAttribute(name, String(value));

        // Value first and strong; the date follows.
        tooltip.replaceChildren(
            el('strong', null, formatCount(points[index].activeUsers)),
            el('span', null, `users · ${longDate(points[index].date)}`)
        );
        tooltip.hidden = false;
        // The SVG scales with its container, so convert to CSS pixels.
        const scale = chart.getBoundingClientRect().width / W;
        tooltip.style.left = `${px * scale}px`;
        tooltip.style.top = `${py * scale}px`;
    };
    const hide = () => {
        crosshair.setAttribute('visibility', 'hidden');
        marker.setAttribute('visibility', 'hidden');
        tooltip.hidden = true;
    };

    hit.addEventListener('pointermove', (event) => {
        const box = chart.getBoundingClientRect();
        const svgX = (event.clientX - box.left) * (W / box.width);
        showAt(last === 0 ? 0 : Math.round(((svgX - pad.left) / plotW) * last));
    });
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => showAt(index));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowLeft') showAt(index - 1);
        else if (event.key === 'ArrowRight') showAt(index + 1);
        else return;
        event.preventDefault();
    });

    return wrap;
}

// The chart's table-view twin: every value reachable without hovering.
function dailyTable(points) {
    const details = el('details', 'chart-table');
    details.append(el('summary', null, 'Show as table'));
    const table = el('table', 'data-table');
    const headRow = el('tr');
    headRow.append(el('th', null, 'Date'), el('th', 'num', 'Active users'));
    const head = el('thead');
    head.append(headRow);
    const rows = el('tbody');
    for (const point of points) {
        const row = el('tr');
        row.append(el('td', null, longDate(point.date)), el('td', 'num', formatCount(point.activeUsers)));
        rows.append(row);
    }
    table.append(head, rows);
    details.append(table);
    return details;
}

const TABLE_PAGE = 25;

const plural = (count, word) => `${formatCount(count)} ${count === 1 ? word : `${word}s`}`;

// Only real web images: a thumbnail URL comes from the database, which anyone
// can write to.
const isSafeImage = (url) => typeof url === 'string' && /^https:\/\//.test(url);

// What to register in GA4 for a section to appear, and that GA does not fill in
// the past.
function missingNote(params, what) {
    const note = el('div', 'analytics-missing');
    note.append(el('p', null, `${what} need these custom dimensions registered in GA4 → Admin → Custom definitions, with scope Event:`));
    const list = el('p', 'missing-params');
    for (const param of params) list.append(el('code', null, param));
    note.append(list);
    note.append(el('p', 'analytics-footnote', 'Data starts from the day each one is registered; GA does not fill in the past.'));
    return note;
}

function titleList(summary, items) {
    const details = el('details', 'title-list');
    details.append(el('summary', null, summary));
    const list = el('ul');
    for (const item of items) list.append(el('li', null, item));
    details.append(list);
    return details;
}

function movieTable(rows, hasClicks) {
    const wrap = el('div', 'movie-stats-wrap');
    const table = el('table', 'data-table movie-stats');
    const headRow = el('tr');
    headRow.append(
        el('th', null, 'Movie'), el('th', 'num', 'Clicks'), el('th', 'num', 'Plays'),
        el('th', 'num', 'Completed'), el('th', 'num', 'Completion'), el('th', 'num', 'Comments')
    );
    const head = el('thead');
    head.append(headRow);
    const body = el('tbody');

    const fill = (count) => body.replaceChildren(...rows.slice(0, count).map((row) => {
        const tr = el('tr');
        const cell = el('td', 'movie-cell');
        const thumb = el('span', 'movie-thumb');
        if (isSafeImage(row.thumbnail)) {
            const img = el('img');
            img.src = row.thumbnail;
            img.alt = '';
            img.loading = 'lazy';
            // A broken image leaves the empty slot, so titles stay aligned.
            img.addEventListener('error', () => img.remove());
            thumb.append(img);
        }
        cell.append(thumb, el('span', 'movie-name', row.title));
        if (row.copies > 1) cell.append(el('span', 'copies-badge', `${row.copies} copies`));
        tr.append(
            cell,
            el('td', 'num', hasClicks ? formatCount(row.clicks) : '—'),
            el('td', 'num strong', formatCount(row.plays)),
            el('td', 'num', formatCount(row.completes)),
            el('td', 'num', formatPercent(row.completionRate)),
            el('td', 'num', formatCount(row.comments))
        );
        return tr;
    }));

    fill(TABLE_PAGE);
    table.append(head, body);
    wrap.append(table);

    if (rows.length > TABLE_PAGE) {
        const more = el('button', 'btn btn-ghost btn-sm', `Show all ${formatCount(rows.length)}`);
        more.type = 'button';
        more.addEventListener('click', () => {
            fill(rows.length);
            more.remove();
        });
        wrap.append(more);
    }
    return wrap;
}

function movieSection(data, library, commentRows) {
    const section = el('section', 'analytics-section');
    section.append(el('h3', 'analytics-heading', 'Movie performance'));
    const card = el('div', 'analytics-card');
    section.append(card);

    if (!data.movies) {
        card.append(missingNote(data.missingDimensions.filter((param) => param !== 'category_name'), 'Per-movie figures'));
        return section;
    }

    const { startMs, endMs } = rangeBounds(data.range);
    const comments = commentsInRange(commentRows, startMs, endMs);
    const { rows, neverPlayed, notInLibrary } = buildMovieRows(data.movies, library, comments);
    const hasClicks = data.movies.clicks !== null;

    if (!hasClicks) {
        const clickParams = data.missingDimensions.filter((param) => param === 'item_name' || param === 'item_id');
        if (clickParams.length) card.append(missingNote(clickParams, 'Clicks'));
    }

    card.append(rows.length ? movieTable(rows, hasClicks) : el('p', 'analytics-empty', 'No plays in this period.'));
    card.append(el('p', 'analytics-footnote',
        "Plays can count twice when a viewer switches to fullscreen — a quirk in the app's logging — which also pulls completion rates down."));

    if (neverPlayed.length) {
        card.append(titleList(
            `No plays in this period: ${plural(neverPlayed.length, 'title')}`,
            neverPlayed.map((row) => (row.copies > 1 ? `${row.title} (${row.copies} copies)` : row.title))
        ));
    }
    if (notInLibrary.length) {
        card.append(titleList(
            `Renamed or removed: ${plural(notInLibrary.length, 'title')} still in Google Analytics`,
            notInLibrary.map((row) => `${row.key} — ${plural(row.plays, 'play')}`)
        ));
    }
    return section;
}

function spinner() {
    const box = el('div', 'loading-state');
    box.append(el('div', 'spinner'), el('p', null, 'Loading analytics...'));
    return box;
}

export function initAnalyticsView({ section, getMovies, getCommentRows }) {
    const body = section?.querySelector('#analytics-body');
    // Without both, rendering could throw into the listeners that call rerender.
    if (!section || !body) return { show() {}, rerender() {} };
    const rangeButtons = [...section.querySelectorAll('.range-btn')];

    let range = 28;
    let data = null;     // the response on screen
    let latest = 0;      // the newest request; answers to older ones are dropped
    let started = false;

    for (const button of rangeButtons) {
        button.addEventListener('click', () => {
            const next = Number(button.dataset.range);
            if (next === range) return;
            range = next;
            for (const other of rangeButtons) {
                other.setAttribute('aria-pressed', String(Number(other.dataset.range) === range));
            }
            load();
        });
    }

    async function load() {
        const request = ++latest;
        // A refetch keeps the previous figures on screen, dimmed: no skeleton
        // and no layout jump. Only the very first load shows a spinner.
        if (data) body.classList.add('is-refreshing');
        else body.replaceChildren(spinner());

        let status = 0;
        let payload = {};
        try {
            const response = await fetch(`/api/analytics?range=${range}`);
            status = response.status;
            payload = await response.json().catch(() => ({}));
        } catch (error) {
            payload = { error: 'network', detail: error.message };
        }

        // A range picked meanwhile has made this answer stale.
        if (request !== latest) return;
        body.classList.remove('is-refreshing');

        if (status === 200) {
            data = payload;
            render();
            return;
        }
        data = null;
        if (payload.error === 'not_configured') showSetup(payload.detail);
        else if (payload.error === 'no_access') showNoAccess(payload.serviceAccount, payload.detail);
        else showError(payload.detail || payload.error || `Analytics request failed (${status})`);
    }

    function render() {
        try {
            body.replaceChildren(...buildReport(data, getMovies() || [], getCommentRows() || []));
        } catch (error) {
            console.error('Rendering analytics failed:', error);
            showError(error.message);
        }
    }

    function retryButton(label) {
        const button = el('button', 'btn btn-secondary btn-sm', label);
        button.type = 'button';
        button.addEventListener('click', load);
        return button;
    }

    function showSetup(detail) {
        const card = el('div', 'analytics-card analytics-state');
        card.append(el('h3', null, 'Connect Google Analytics'));
        card.append(el('p', 'analytics-lead',
            "The dashboard reads the app's analytics through a Google service account. Set it up once:"));
        if (detail) card.append(el('p', 'analytics-problem', detail));

        const steps = el('ol', 'setup-steps');
        for (const step of SETUP_STEPS) {
            const item = el('li', null, step.text);
            if (step.link) {
                const link = el('a', null, step.link.label);
                link.href = step.link.href;
                link.target = '_blank';
                link.rel = 'noopener';
                item.append(' ', link);
            }
            steps.append(item);
        }
        card.append(steps, retryButton('Check again'));
        body.replaceChildren(card);
    }

    function showNoAccess(email, detail) {
        const card = el('div', 'analytics-card analytics-state');
        card.append(el('h3', null, 'Google Analytics refused access'));
        card.append(el('p', 'analytics-lead',
            'Add this service account in GA4 → Admin → Property access management, with the Viewer role:'));
        card.append(el('code', 'analytics-email', email || 'unknown'));
        // A disabled API or a wrong property ID is refused the same way; GA's
        // own words tell them apart.
        if (detail) card.append(el('p', 'analytics-problem', `Google said: ${detail}`));
        card.append(el('p'), retryButton('Check again'));
        body.replaceChildren(card);
    }

    function showError(detail) {
        const card = el('div', 'analytics-card analytics-state');
        card.append(el('h3', null, "Couldn't load analytics"));
        card.append(el('p', 'analytics-problem', detail));
        card.append(retryButton('Retry'));
        body.replaceChildren(card);
    }

    return {
        // The router calls this whenever the view opens. Only the first visit
        // fetches: GA's figures change at most daily, and the range buttons
        // refetch on demand. Later visits re-join what was already fetched,
        // because movies or comments may have changed while the view was
        // hidden, when rerender() does nothing.
        show() {
            if (!started) {
                started = true;
                load();
            } else if (data) {
                render();
            }
        },
        // Called when movies or comments change. The join is redone from the
        // figures already fetched; GA is not asked again.
        rerender() {
            if (data && !section.classList.contains('hidden')) render();
        }
    };
}

// GA's own caveats, stated rather than hidden: both make totals undercount.
function notesLine(notes) {
    const parts = [];
    if (notes?.thresholded) parts.push('Google withheld some small groups for privacy, so totals may undercount.');
    if (notes?.otherRow) parts.push('Some values were grouped into "(other)".');
    return parts.length ? el('p', 'analytics-notes', parts.join(' ')) : null;
}

function buildReport(data, movies, commentRows) {
    const parts = [];
    const notes = notesLine(data.notes);
    if (notes) parts.push(notes);
    parts.push(audienceSection(data.audience));
    parts.push(movieSection(data, movies, commentRows));
    return parts;
}

// Stat tiles: a sentence-case label and a compact value (1,284 / 12.9K).
function audienceSection(audience) {
    const section = el('section', 'analytics-section');
    section.append(el('h3', 'analytics-heading', 'Audience'));

    const perUser = audience.activeUsers > 0 ? audience.engagementSeconds / audience.activeUsers : 0;
    const tiles = el('div', 'stat-row');
    for (const [label, value] of [
        ['Active users', formatCompact(audience.activeUsers)],
        ['New users', formatCompact(audience.newUsers)],
        ['Sessions', formatCompact(audience.sessions)],
        ['Engagement per user', formatDuration(perUser)]
    ]) {
        const tile = el('div', 'stat-tile');
        tile.append(el('span', 'stat-label', label), el('span', 'stat-value', value));
        tiles.append(tile);
    }
    section.append(tiles);

    const card = el('div', 'analytics-card');
    card.append(el('h4', 'chart-title', 'Daily active users'));
    if (audience.daily.length) {
        card.append(lineChart(audience.daily), dailyTable(audience.daily));
    } else {
        card.append(el('p', 'analytics-empty', 'No activity in this period.'));
    }
    section.append(card);
    return section;
}
