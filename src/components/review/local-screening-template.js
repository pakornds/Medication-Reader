// Fixed application markup; encounter and catalogue data are inserted using textContent.
export const markup = `
<section class="local-review" id="local-review" aria-labelledby="medicines-heading">
        <fieldset id="local-controls">
          <legend id="medicines-heading">Medicines for screening</legend>
          <form class="catalogue-search" id="catalogue-search" role="search">
            <label for="catalogue-query">Search the Thai medicines catalogue</label>
            <div class="local-actions">
              <input id="catalogue-query" type="search" required maxlength="120" placeholder="Medicine name or TPU code" autocomplete="off">
              <button type="submit" class="regimen-button">Search</button>
            </div>
          </form>
          <p id="catalogue-status" role="status"></p>
          <ul id="catalogue-results" aria-label="Matching products"></ul>
          <button type="button" class="local-secondary" id="add-unknown">Add unidentified medicine</button>
          <p id="other-case-row" hidden></p>
          <div id="catalogue-rows" aria-label="Medicines in this review"></div>
          <div class="screen-actions">
            <button type="button" class="regimen-button" id="run-local" disabled>Check interactions and shared ingredients</button>
            <p id="local-status" role="status"></p>
          </div>
        </fieldset>
        <div id="local-report" aria-label="Medication screening report"></div>
      </section>

      <template id="catalogue-row-template">
        <article class="local-row">
          <header>
            <div><h3></h3><small class="row-code"></small></div>
            <button type="button" class="local-secondary remove-row">Remove</button>
          </header>
          <p class="row-status"></p>
          <details class="row-details" open>
            <summary>Identity and use evidence</summary>
            <form class="local-verify">
              <label>Identity source
                <select name="identity_source" required>
                  <option value="">Select source</option>
                  <option value="transfer_record">Transfer record</option>
                  <option value="prescription">Prescription</option>
                  <option value="other_record">Transcribed packaging or other record</option>
                </select>
              </label>
              <label>Product wording on that source
                <input name="identity_text" required autocomplete="off" placeholder="Copy the identifying wording">
              </label>
              <label>Use reported by
                <select name="use_source" required>
                  <option value="">Select source</option>
                  <option value="patient_report">Patient</option>
                  <option value="caregiver_report">Caregiver</option>
                </select>
              </label>
              <label>Reported use
                <input name="use_text" required autocomplete="off" placeholder="Record what they said about this medicine">
              </label>
              <label>Use at this encounter
                <select name="use_status" required>
                  <option value="">Select status</option>
                  <option value="current">Currently used</option>
                  <option value="no_longer_current">Stopped</option>
                  <option value="uncertain">Uncertain</option>
                </select>
              </label>
              <label>Reviewing as
                <select name="reviewer_role" required>
                  <option value="">Select your role</option>
                  <option value="pharmacist">Pharmacist</option>
                  <option value="doctor">Doctor</option>
                </select>
              </label>
              <button type="submit" class="regimen-button">Verify identity and record use</button>
            </form>
          </details>
        </article>
      </template>
`;
