from test_admissions import Case, client, headers, photo, record


def test_discharge_list_then_blister_loose_tablets_and_boxed_liquid(client):
    case = Case(client, "doctor")
    for n, (name, package) in enumerate([
        ("Demo A tablet", "blister"), ("Demo B tablet", "loose tablets"), ("Demo C liquid", "boxed liquid"),
    ]):
        prior = f"discharge-{n}"
        row = case.add(record(prior, "transfer_record", name+" · documented prior patient interview", name=name))
        case.interview(row, prior, schedule="as needed" if n == 1 else "scheduled")
        before = case.state["rows"][row]["interview"]
        new_photo = photo(f"later-{n}", package, appearance="separate tablet" if n == 1 else None,
                          name=None if n == 1 else name)
        case.send("link", row_id=row, entry=new_photo, confirmed=False, status=422)
        case.link(row, new_photo)
        case.send("verify", row_id=row, source_id=prior)
        assert case.state["rows"][row]["verified"]["answer"] == before
        assert len(case.state["rows"]) == n+1
    case.send("finish")
    case.send("import", role="pharmacist", row_ids=["item-1", "item-3"])
    assert case.state["receipts"][0]["imported_row_ids"] == ["item-1", "item-3"]


def test_reverse_directions_require_matched_label_and_keep_source_on_import(client):
    case = Case(client, "nurse")
    row = case.add(record("initial", "prescription", "Demo syrup", name="Demo syrup"))
    label = photo("reverse", "box", name="Demo syrup")
    label.update(wording="Demo syrup · each morning", directions="each morning")
    label["photo"]["pairing"] = "uncertain"
    case.send("link", row_id=row, entry=label, confirmed=True, status=422)
    label["photo"]["pairing"] = "matched"
    case.link(row, label)
    case.link(row, record("account", "patient_report", "Reports using the syrup at night"))
    case.interview(row, "account", schedule="night")
    case.send("verify", row_id=row, source_id="account")
    case.send("import", role="pharmacist", row_ids=[row])
    receipt = case.state["receipts"][0]
    snapshot = client.get("/imports", headers=headers("pharmacist"),
                          params={"imported_at": receipt["imported_at"]}).json()[0]["snapshot"]
    saved = snapshot["rows"][0]
    assert saved["label_fields"]["directions"]["evidence"]["source_id"] == "reverse"
    assert saved["reported_use"][0]["evidence"]["source_id"] == "account"
    assert saved["verification"]["frequency"]["value"] == "night"


def test_lookup_and_rescan_cannot_replace_independent_identity_decision(client):
    case = Case(client, "nurse")
    row = case.add(photo("original", "bag", "round"))
    case.link(row, record("lookup", "transfer_record", "Demo candidate", name="Demo candidate"))
    assert case.state["rows"][row]["proposal"]["reference"] == "lookup"
    case.send("decide", role="pharmacist", row_id=row, source_id="lookup", name="Demo candidate",
              outcome="confirm", finding="Lookup alone", status=422)
    case.send("finish", status=422)
    assert case.state["rows"][row]["entries"][0]["source"]["id"] == "original"
