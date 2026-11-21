/* Serve the repository root, then run with Playwright on NODE_PATH. */
const {chromium} = require("playwright");
const assert = require("node:assert/strict");
const base = process.env.PACKAGE_LAYOUT_URL ?? "http://127.0.0.1:18484";

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({viewport:{width:1280,height:1000}});
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base + "/tests/ui/package-layout/preview.html");
    const scene = side => page.locator('[data-side="' + side + '"]');
    const read = async () => JSON.parse(await page.locator("#output").textContent());
    async function draw(side, x, y, width, height) {
      const stage = scene(side).locator(".pl-stage");
      await stage.scrollIntoViewIfNeeded();
      const rect = await stage.boundingBox();
      await page.mouse.move(rect.x + x * rect.width, rect.y + y * rect.height);
      await page.mouse.down();
      await page.mouse.move(rect.x + (x + width) * rect.width, rect.y + (y + height) * rect.height,{steps:5});
      await page.mouse.up();
    }
    const click = text => page.getByRole("button", {name:text,exact:true}).click();
    await draw("front",.06,.12,.32,.41);
    await draw("front",.44,.16,.32,.42);
    let {snapshot} = await read();
    assert.equal(snapshot.packages.length,2);
    assert.equal(snapshot.reverse,null);
    const [a,b] = snapshot.packages;
    await click("Load reverse");
    await click("Show front guide");
    assert.equal(await page.locator(".pl-guide").count(),1);
    await click("Hide front guide");
    await scene("reverse").getByLabel("Zoom").selectOption("1.5");
    await draw("reverse",.06,.12,.32,.41);
    await scene("reverse").getByLabel("Zoom").selectOption("1");
    await draw("reverse",.44,.16,.32,.42);
    const [reverseB,reverseA] = (await read()).snapshot.reverse.regions;
    assert.ok(Math.abs(reverseB.bounds.x - .06) < .01);
    await page.getByLabel("Package",{exact:true}).selectOption(a.id);
    assert.equal(await page.getByLabel("Reverse region",{exact:true}).inputValue(),reverseB.id);
    assert.deepEqual((await read()).snapshot.reverse_matches,[]);
    await click("Match package");
    await page.getByLabel("Reverse region",{exact:true}).selectOption(reverseA.id);
    await click("Match package");
    snapshot = (await read()).snapshot;
    assert.deepEqual(snapshot.reverse_matches[0].region,{case_id:"synthetic-layout",side:"reverse",attachment_id:"demo-reverse-1",revision:1,region_id:reverseA.id});
    assert.equal(snapshot.packages[0].front_regions[0].attachment_id,"demo-front");
    await page.getByLabel("Package",{exact:true}).selectOption(b.id);
    assert.equal(await page.getByLabel("Reverse region",{exact:true}).locator('option[value="' + reverseA.id + '"]').count(),0);
    await click("Mark hidden");
    assert.deepEqual((await read()).observations.hiddenPackageIds,[b.id]);
    await page.getByLabel("Package",{exact:true}).selectOption(a.id);
    await page.screenshot({path:process.env.PACKAGE_LAYOUT_SCREENSHOT ?? "/tmp/package-layout-paired.png",fullPage:true});
    await click("Replace reverse");
    assert.deepEqual((await read()).snapshot.reverse_matches,[]);
    assert.deepEqual((await read()).snapshot.packages.map(pkg=>pkg.id),[a.id,b.id]);
    await click("Load example regions");
    const last = (await read()).snapshot.reverse.regions.at(-1);
    await scene("reverse").getByLabel("Region",{exact:true}).selectOption(last.id);
    await click("Mark opaque");
    assert.equal((await read()).snapshot.reverse.regions.at(-1).visibility,"opaque");
    await scene("reverse").locator("summary").click();
    await scene("reverse").getByLabel("width",{exact:true}).fill(".19");
    await click("Resize region");
    assert.equal((await read()).snapshot.reverse.regions.at(-1).bounds.width,.19);
    await scene("reverse").getByRole("button",{name:"Delete region"}).click();
    assert.equal((await read()).snapshot.reverse.regions.length,2);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
    const mobile = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
    await mobile.goto(base + "/tests/ui/package-layout/preview.html");
    await mobile.evaluate(async () => {
      const {mountPackageLayout} = await import("../../../src/components/package-layout/editor.mjs");
      const editor = mountPackageLayout(document.querySelector("#editor"), {
        caseId:"synthetic-exif", onChange: state => { document.querySelector("#output").textContent = JSON.stringify(state); },
      });
      editor.setPhoto("front", {attachment_id:"rotated-front", revision:3, exif_orientation:6, url:"orientation-6.jpg"});
    });
    const rotated = mobile.locator(".pl-original");
    await rotated.evaluate(image=>image.decode());
    assert.deepEqual(await rotated.evaluate(image=>[image.naturalWidth,image.naturalHeight]),[60,120]);
    const stage = mobile.locator(".pl-stage");
    await stage.scrollIntoViewIfNeeded();
    const rect = await stage.boundingBox();
    const touch = await mobile.context().newCDPSession(mobile);
    const point = (x,y) => ({x:rect.x+rect.width*x,y:rect.y+rect.height*y});
    await touch.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[point(.2,.1)]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[point(.8,.4)]});
    await touch.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
    const oriented = JSON.parse(await mobile.locator("#output").textContent());
    assert.equal(oriented.front.exif_orientation,6);
    assert.equal(oriented.front.attachment_id,"rotated-front");
    const mark = oriented.front.regions[0].bounds;
    for (const [key,value] of Object.entries({x:.2,y:.1,width:.6,height:.3})) assert.ok(Math.abs(mark[key]-value)<.01);
    await mobile.close();
    assert.deepEqual(errors,[]);
    console.log("PASS: manual regions, zoom, swap correction, hidden, opaque, coordinate resize, delete, replacement, mobile layout and touch on a real EXIF-6 fixture.");
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
