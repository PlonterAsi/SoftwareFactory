'use strict';
loadReal();

FONT = getComputedStyle(document.body).fontFamily;
buildTerrain(); resize(); renderBuildBar(); renderTrainBar(); renderBases();
requestAnimationFrame(frame);

// test hooks for play-tests (no effect on play)
window.__sector = { get S() { return S; }, openOrder, sendOrder, get REAL() { return REAL; }, get APPS() { return APPS; }, get IDEAS() { return IDEAS; }, update, place, connect, train, decide, byId, newGame, canPlace, setSpeed };
