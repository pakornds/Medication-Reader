import assert from "node:assert/strict";
import test from "node:test";
import {PackageLayout, boundsBetween, displayPoint} from "../../../src/components/package-layout/layout.mjs";

const box = (x,y=.1) => ({x,y,width:.24,height:.32});
function scene() {
  const state = new PackageLayout("synthetic-case");
  state.replaceView("front", {attachment_id:"front-photo",exif_orientation:6,revision:3});
  state.replaceView("reverse", {attachment_id:"reverse-photo"});
  return state;
}

test("positional suggestions remain unconfirmed; swap, overlap, opacity and hidden state", () => {
  const state = scene();
  const frontA = state.add("front", box(.1));
  const frontB = state.add("front", box(.28));
  const frontC = state.add("front", box(.68));
  const reverseB = state.add("reverse", box(.1));
  const reverseA = state.add("reverse", box(.28));
  const reverseC = state.add("reverse", box(.67));
  const [a,b,c] = state.packages;
  assert.deepEqual(new Set(state.suggestions().values()), new Set([reverseB,reverseA,reverseC]));
  assert.equal(state.suggestions().get(a.id), reverseB);
  assert.deepEqual(state.snapshot().reverse_matches, []);
  state.match(a.id,reverseB);
  state.match(a.id,reverseA);
  assert.throws(() => state.match(b.id,reverseA), /Unmatch/);
  state.clearMatch(b.id,"hidden");
  state.setOpaque(reverseC,true);
  state.match(c.id,reverseC);
  const snapshot = state.snapshot();
  assert.deepEqual(snapshot.packages.map(pkg=>pkg.front_regions[0].region_id),[frontA,frontB,frontC]);
  assert.deepEqual(snapshot.reverse_matches.map(m=>m.region.region_id),[reverseA,reverseC]);
  assert.equal(snapshot.reverse.regions[2].visibility,"opaque");
  assert.equal(snapshot.reverse.revision,2);
  assert.ok(snapshot.reverse_matches.every(match => match.region.revision === 2));
  assert.equal(b.status,"hidden");
  assert.deepEqual(snapshot.sources,[]);
  assert.deepEqual(snapshot.packages.flatMap(pkg=>pkg.items),[]);
});

test("manual coordinates refer to displayed pixels at current zoom including reverse drag", () => {
  const state = scene();
  const viewport = {left:-100,top:90,width:500,height:800};
  const bounds = boundsBetween(displayPoint(viewport,200,490),displayPoint(viewport,0,170));
  const id = state.add("front",bounds);
  const reverseId = state.add("reverse",box(.1));
  state.match(state.packages[0].id,reverseId);
  const snapshot = state.snapshot();
  assert.equal(snapshot.front.exif_orientation,6);
  assert.deepEqual(snapshot.front.regions[0].bounds,{x:.2,y:.1,width:.6-.2,height:.4});
  assert.deepEqual(snapshot.packages[0].front_regions[0],{case_id:"synthetic-case",side:"front",attachment_id:"front-photo",revision:3,region_id:id});
  assert.equal(snapshot.reverse_matches[0].region.attachment_id,"reverse-photo");
  state.edit("front",id,box(.15));
  assert.deepEqual(state.snapshot().reverse_matches,[]);
  assert.equal(state.snapshot().front.revision,4);
  assert.equal(state.snapshot().packages[0].front_regions[0].revision,4);
  assert.equal(state.packages[0].id,snapshot.packages[0].id);
  assert.throws(()=>state.edit("front",id,box(.95)), /inside/);
  state.remove("front",id);
  assert.deepEqual(state.snapshot().packages,[]);
});

test("retakes reject obsolete proposals, preserve unaffected front IDs, and clear stale links", () => {
  const state = scene();
  const f = state.add("front",box(.2));
  const original = state.views.reverse;
  assert.deepEqual(state.addProposals("reverse",{...original,bounds:[]}),[]);
  assert.throws(()=>state.addProposals("reverse",{...original,bounds:[box(.1),box(1)]}),/inside/);
  assert.equal(original.regions.length,0);
  const [r] = state.addProposals("reverse",{...original,bounds:[box(.1)]});
  state.match(state.packages[0].id,r);
  state.replaceView("reverse",null);
  assert.equal(state.snapshot().reverse,null);
  assert.equal(state.packages[0].frontId,f);
  assert.deepEqual(state.snapshot().reverse_matches,[]);
  state.replaceView("reverse",{attachment_id:"retake"});
  assert.equal(state.views.reverse.revision,2);
  assert.deepEqual(state.addProposals("reverse",{...original,bounds:[box(.4)]}),[]);
  assert.throws(()=>state.replaceView("reverse",{attachment_id:"reverse-photo"}),/fresh/);
  assert.throws(()=>state.replaceView("reverse",{attachment_id:"again",revision:1}),/newer/);
  state.replaceView("front",{attachment_id:"front-retake"});
  assert.equal(state.views.front.revision,4);
  assert.deepEqual(state.packages,[]);
});
