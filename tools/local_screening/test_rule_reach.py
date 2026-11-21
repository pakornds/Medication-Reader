"""Aggregate reach counts distinct Thai products on opposite sides of a source rule."""

import sqlite3
from contextlib import closing

from audit_rule_reach import audit


def test_unassessed_candidate_and_singleton_self_match():
    with closing(sqlite3.connect(":memory:")) as tmt, closing(sqlite3.connect(":memory:")) as fest:
        tmt.executescript("""
            CREATE TABLE metadata(key, value);
            INSERT INTO metadata VALUES ('fest_sha256','sha'),('tmt_release','tmt'),('mapping_sha256','map');
            CREATE TABLE product(tpu,ddi_status,active_tmt);
            INSERT INTO product VALUES ('a','mapped',1),('b','mapped',1),('c','mapped',1);
            CREATE TABLE product_atc(tpu,atc);
            INSERT INTO product_atc VALUES ('a','C10AA01'),('b','J01FA09'),('c','N00XX00');
        """)
        fest.executescript("""
            CREATE TABLE source(sha256); INSERT INTO source VALUES ('sha');
            CREATE TABLE rule(id); INSERT INTO rule VALUES('pair'),('self');
            CREATE TABLE atc_member(rule_id,side,atc);
            INSERT INTO atc_member VALUES ('pair',1,'C10AA'),('pair',2,'J01FA09'),
                ('self',1,'N00XX00'),('self',2,'N00XX00');
            CREATE TABLE unassessed(entry_xml);
            INSERT INTO unassessed VALUES ('<entry><InteraksjonIkkeVurdert><Atc V="J01FA09"/></InteraksjonIkkeVurdert></entry>');
        """)
        report = audit(tmt, fest)
        assert report["mapped_products_by_atcs_without_an_exact_unassessed_notice"] == {"all_codes": 2, "no_codes": 1}
        assert report["mapped_products_with_at_least_one_possible_rule_partner"] == 2
        assert report["rules_with_two_distinct_possible_thai_products"] == 1
