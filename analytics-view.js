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
    return section;
}
