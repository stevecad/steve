# STEVE material library — sources and licenses

`library.json` holds 352 engineering materials with mechanical, thermal and appearance data, built by
`scripts/materials/build.py` from the open datasets below. The runtime's `runtime/steve/materials.json` (names,
categories, densities) is generated from the same data. Numbers are never invented: a property no source gives is
`null`. Every value names its source key, and each material's `sources` entry gives the exact record, URL and license.

Rebuild and check (network only for sources not yet cached or snapshotted):

```sh
uv run --with pyyaml python scripts/materials/build.py            # add --refresh to re-query Wikidata and re-parse the Wood Handbook
uv run python scripts/materials/validate.py
```

## Sources

| Key | Source | License | Revision |
|---|---|---|---|
| `materials-project` | [Materials Project](https://next-gen.materialsproject.org) | CC-BY-4.0 | snapshot in scripts/materials/snapshots/materials_project.json |
| `freecad` | [FreeCAD material cards](https://github.com/FreeCAD/FreeCAD/tree/84ae7a7c8ee9e9c2c86c739f364ace4822caf950/src/Mod/Material/Resources/Materials/Standard) | Per card: CC-BY-3.0, CC-BY-4.0, CC-BY-SA-4.0, LGPL-2.0-or-later or LGPL-2.1-or-later (see each record) | 84ae7a7c8ee9e9c2c86c739f364ace4822caf950 |
| `physicallybased` | [Physically Based (physicallybased.info)](https://github.com/AntonPalmqvist/physically-based-api/blob/4d1f4b342087f2438f5f89db9d39246a4988b0f7/deploy/v2/materials.json) | CC0-1.0 | 4d1f4b342087f2438f5f89db9d39246a4988b0f7 |
| `wikidata` | [Wikidata](https://www.wikidata.org/) | CC0-1.0 | query 2026-09-30 |
| `ultimaker` | [Ultimaker fdm_materials](https://github.com/Ultimaker/fdm_materials/tree/886e7ad927463493cc9c64f427b1ae2cf4ce12c1) | CC0-1.0 | 886e7ad927463493cc9c64f427b1ae2cf4ce12c1 |
| `usda-wood-handbook` | [USDA Forest Products Laboratory, Wood Handbook (FPL-GTR-282, 2021), Table 5-3a](https://research.fs.usda.gov/treesearch/62200) | Public domain (U.S. Government work) | FPL-GTR-282 (2021) |
| `steve` | STEVE appearance presets | CC0-1.0 | — |
| `ref:dew-1-6582` | [dew-1-6582](https://swisssteel-group.com/content-media/documents/Data-Sheets/Engineering-Steel/1.6582_en.pdf) | Facts quoted from the cited document | — |
| `ref:outokumpu-grades-properties` | [outokumpu-grades-properties](https://www.outokumpu.com/-/media/from-sharepoint/documents/product/outokumpu-steel-grades-properties-global-standards.pdf) | Facts quoted from the cited document | — |
| `ref:sci-p413-design-manual-stainless-4ed` | [sci-p413-design-manual-stainless-4ed](https://www.cedinox.es/export/sites/cedinox/.galleries/publicaciones-tecnicas/Design-manual-for-structural-stainless-steel-4ed-English.pdf) | Facts quoted from the cited document | — |
| `ref:ugitech-ugima-4057` | [ugitech-ugima-4057](https://swisssteel-group.com/content-media/documents/_import/DAT-UGIMA4057-en.pdf) | Facts quoted from the cited document | — |
| `ref:swisssteel-4057` | [swisssteel-4057](https://swisssteel-group.com/content-media/documents/Data-Sheets/Stainless-Steel/Datenblatt_4057_UK.pdf) | Facts quoted from the cited document | — |
| `ref:smc-inconel-625` | [smc-inconel-625](https://www.specialmetals.com/documents/technical-bulletins/inconel/inconel-alloy-625.pdf) | Facts quoted from the cited document | — |
| `ref:smc-inconel-718` | [smc-inconel-718](https://www.specialmetals.com/documents/technical-bulletins/inconel/inconel-alloy-718.pdf) | Facts quoted from the cited document | — |
| `ref:smc-nickel-200-201` | [smc-nickel-200-201](https://www.specialmetals.com/documents/technical-bulletins/nickel-200.pdf) | Facts quoted from the cited document | — |
| `ref:daido-titanium-properties` | [daido-titanium-properties](https://www.daido.co.jp/en/products/titanium/properties/index.html) | Facts quoted from the cited document | — |
| `ref:bikar-6061` | [bikar-6061](https://www.bikar.com/fileadmin/user_upload/aluminium/bleche-platten/6061-komplett.pdf) | Facts quoted from the cited document | — |
| `ref:bikar-7020` | [bikar-7020](https://www.bikar.com/fileadmin/Unterlagen_BIKAR/Unterlagen_BIKAR_eng/7020-complete-en.pdf) | Facts quoted from the cited document | — |
| `ref:cda-c51000` | [cda-c51000](https://alloys.copper.org/alloy/C51000) | Facts quoted from the cited document | — |
| `ref:cda-c75200` | [cda-c75200](https://alloys.copper.org/alloy/C75200) | Facts quoted from the cited document | — |
| `ref:cda-c26000` | [cda-c26000](https://alloys.copper.org/alloy/C26000) | Facts quoted from the cited document | — |
| `ref:npl-kaye-laby-2-2-2` | [npl-kaye-laby-2-2-2](https://web.archive.org/web/20190422003653id_/http://www.kayelaby.npl.co.uk/general_physics/2_2/2_2_2.html) | Facts quoted from the cited document | — |
| `ref:npl-kaye-laby-2-3-5` | [npl-kaye-laby-2-3-5](https://web.archive.org/web/20190512035127id_/http://www.kayelaby.npl.co.uk/general_physics/2_3/2_3_5.html) | Facts quoted from the cited document | — |
| `ref:rsc-periodic-table` | [rsc-periodic-table](https://periodic-table.rsc.org/element/77/iridium) | Facts quoted from the cited document | — |
| `ref:materion-truextent-tds2011` | [materion-truextent-tds2011](https://hkvxni.files.cmp.optimizely.com/download/11336490a04011ee9a24d2cdb262657f) | Facts quoted from the cited document | — |
| `ref:nist-kim-ledbetter-1998-indium` | [nist-kim-ledbetter-1998-indium](https://www.nist.gov/publications/low-temperature-elastic-constants-polycrystalline-indium) | Facts quoted from the cited document | — |
| `ref:eagle-alloys-rhenium` | [eagle-alloys-rhenium](https://www.eaglealloys.com/rhenium) | Facts quoted from the cited document | — |
| `ref:alleima-zr-702` | [alleima-zr-702](https://www.alleima.com/en/technical-center/material-datasheets/tube-and-pipe-seamless/alleima-zr-702/) | Facts quoted from the cited document | — |
| `ref:kyocera-sn241o` | [kyocera-sn241o](https://kyocera-solutions.de/fileadmin/user_upload/Download/werkstoffdatenblaetter/siliziumnitrid/Kyocera_Fineceramics_Europe_SN241O.pdf) | Facts quoted from the cited document | — |
| `ref:kyocera-sc211` | [kyocera-sc211](https://shop.kyocera-solutions.de/storage/downloads/sc211-englisch.pdf) | Facts quoted from the cited document | — |
| `ref:kyocera-ao479o` | [kyocera-ao479o](https://www.kyocera-fineceramics.de/fileadmin/user_upload/Download/werkstoffdatenblaetter/aluminiumoxid/Kyocera_Fineceramics_Europe_AO479O.pdf) | Facts quoted from the cited document | — |
| `ref:kyocera-an216a` | [kyocera-an216a](https://www.kyocera-fineceramics.de/fileadmin/user_upload/Download/werkstoffdatenblaetter/aluminiumnitrid/Kyocera_Fineceramics_Europe_AN216A.pdf) | Facts quoted from the cited document | — |
| `ref:kyocera-sa100` | [kyocera-sa100](https://www.kyocera-fineceramics.de/fileadmin/user_upload/Download/werkstoffdatenblaetter/saphir/Kyocera_Fineceramics_Europe_SA100.pdf) | Facts quoted from the cited document | — |
| `ref:saint-gobain-norbide-hp-b4c` | [saint-gobain-norbide-hp-b4c](https://www.ceramicsrefractories.saint-gobain.com/fr/files/3956/view) | Facts quoted from the cited document | — |
| `ref:schott-borofloat-33` | [schott-borofloat-33](https://www.schott.com/en-us/products/borofloat/technical-details) | Facts quoted from the cited document | — |
| `ref:schott-borofloat-33-datasheet` | [schott-borofloat-33-datasheet](https://www.edmundoptics.com/ViewDocument/schott-borofloat-technical-data-sheet-english.pdf) | Facts quoted from the cited document | — |
| `ref:agc-planibel` | [agc-planibel](https://www.agc-yourglass.com/sites/default/files/2024-12/TDS_Planibel_1224_EN.pdf) | Facts quoted from the cited document | — |
| `ref:vasglass-float` | [vasglass-float](https://vasglass.gr/en/products/standard-glass/constituent-materials-attributes/) | Facts quoted from the cited document | — |
| `ref:crystran-mgo` | [crystran-mgo](https://www.crystran.com/optical-materials/magnesium-oxide-mgo) | Facts quoted from the cited document | — |
| `ref:crystran-crystal-quartz` | [crystran-crystal-quartz](https://crystran.com/optical-materials/crystal-quartz-sio2) | Facts quoted from the cited document | — |
| `ref:goodfellow-hp-b4c` | [goodfellow-hp-b4c](https://www.goodfellow.com/usa/hot-pressed-boron-carbide-sheet-group) | Facts quoted from the cited document | — |
| `ref:goodfellow-wc-co6` | [goodfellow-wc-co6](https://www.goodfellow.com/usa/tungsten-carbide-cobalt-rod-group) | Facts quoted from the cited document | — |
| `ref:element-six-balmer-2009` | [element-six-balmer-2009](https://arxiv.org/pdf/0909.1185) | Facts quoted from the cited document | — |
| `ref:meusburger-cf-h40s` | [meusburger-cf-h40s](https://www.meusburger.com/en-gb/products/plates-and-bars/material-grades/cf-h40s-carbide) | Facts quoted from the cited document | — |
| `ref:roehm-plexiglas-gs-xt-211-1` | [roehm-plexiglas-gs-xt-211-1](https://www.voskunststoffen.nl/files/166151/datasheet%20plexiglas%20XT%20GS.pdf) | Facts quoted from the cited document | — |
| `ref:simona-pe-tech-info` | [simona-pe-tech-info](https://www.simona.de/fileadmin/user_upload/Medien/Mediacenter/Technische_Informationen/tech.info_SIMONA_PE_EN.pdf) | Facts quoted from the cited document | — |
| `ref:roechling-polystone-g-100` | [roechling-polystone-g-100](https://www.roechling.com/industrial/materials/thermoplastics/industrial-plastics/pe/pe-hd-pe-100/polystone-g-100-natural-746620) | Facts quoted from the cited document | — |
| `ref:roechling-polystone-e` | [roechling-polystone-e](https://www.roechling.com/fileadmin/assets/Technical%20Data%20Sheet%20Polystone%C2%AE%20E%20natural%20extruded%20591123%20EN.pdf) | Facts quoted from the cited document | — |
| `ref:mdc-bakelite-pf31` | [mdc-bakelite-pf31](https://materialdatacenter.com/ms/pt/Bakelite/Bakelite+Synthetics/Bakelite%C2%AE+PF+31/0418ed2f/295) | Facts quoted from the cited document | — |
| `ref:edmund-optics-ge-windows` | [edmund-optics-ge-windows](https://www.edmundoptics.co.uk/f/PdfExport/13137) | Facts quoted from the cited document | — |
| `ref:edmund-optics-si-windows` | [edmund-optics-si-windows](https://www.edmundoptics.co.uk/f/PdfExport/13238) | Facts quoted from the cited document | — |
| `ref:sgl-sigrafine-r4550` | [sgl-sigrafine-r4550](https://www.sglgroup.com/data/pdf/SGL-Datasheet-SIGRAFINE-R4550-EN.pdf) | Facts quoted from the cited document | — |
| `ref:michelmersh-carlton-weathered-red` | [michelmersh-carlton-weathered-red](https://checkout.mkm.com/content/products/pdf/8490/73mm-carlton-weathered-red-brick-b018742_TechData_1.pdf) | Facts quoted from the cited document | — |
| `ref:en1992-1-2-background-docs` | [en1992-1-2-background-docs](https://www.eurocodes.fi/wp-content/uploads/1992/1992-1-2/BD_EN_1992-1-2_rev2.pdf) | Facts quoted from the cited document | — |
| `ref:heidelberg-betontechnische-daten-2022` | [heidelberg-betontechnische-daten-2022](https://heidelbergmaterials.de/sites/default/files/2023-03/Betontechnische%20Daten%20von%20Heidelberg%20Materials%20Ausgabe%202022_1.pdf) | Facts quoted from the cited document | — |
| `ref:dew-1-6587-de` | [dew-1-6587-de](https://swisssteel-group.com/content-media/documents/Data-Sheets/Engineering-Steel/1.6587_de.pdf) | Facts quoted from the cited document | — |
| `ref:swisssteel-c45e-c45r` | [swisssteel-c45e-c45r](https://swisssteel-group.com/content-media/documents/Data-Sheets/Engineering-Steel/C45E-C45R_en.pdf) | Facts quoted from the cited document | — |
| `ref:lucefin-30crnimo8` | [lucefin-30crnimo8](https://lucefin.com/wp-content/uploads/2025/01/ENG-30CrNiMo8.pdf) | Facts quoted from the cited document | — |
| `ref:lucefin-36crnimo4` | [lucefin-36crnimo4](https://lucefin.com/wp-content/uploads/2025/01/36CrNiMo4-2.pdf) | Facts quoted from the cited document | — |
| `ref:lucefin-36nicrmo16` | [lucefin-36nicrmo16](https://www.lucefin.com/wp-content/files_mf/152353560936NiCrMo16.pdf) | Facts quoted from the cited document | — |
| `ref:lucefin-c15e` | [lucefin-c15e](https://lucefin.com/wp-content/uploads/2025/01/ENG-C15E.pdf) | Facts quoted from the cited document | — |
| `ref:lucefin-c35e` | [lucefin-c35e](https://lucefin.com/wp-content/uploads/2025/01/ENG-C35E.pdf) | Facts quoted from the cited document | — |
| `ref:lucefin-c22e` | [lucefin-c22e](https://www.lucefin.com/wp-content/files_mf/1523536185C22E.pdf) | Facts quoted from the cited document | — |
| `ref:lucefin-c30e` | [lucefin-c30e](https://lucefin.com/wp-content/uploads/2025/01/ENG-C30E.pdf) | Facts quoted from the cited document | — |
| `ref:lucefin-c40e` | [lucefin-c40e](https://lucefin.com/wp-content/uploads/2025/01/ENG-C40E.pdf) | Facts quoted from the cited document | — |
| `ref:lucefin-c55e` | [lucefin-c55e](https://www.lucefin.com/wp-content/files_mf/1523536746C55E.pdf) | Facts quoted from the cited document | — |
| `ref:lucefin-c60e` | [lucefin-c60e](https://lucefin.com/wp-content/uploads/2025/01/ENG-C60E.pdf) | Facts quoted from the cited document | — |
| `ref:arcelormittal-ommis-s355j2ar` | [arcelormittal-ommis-s355j2ar](https://ommis.arcelormittal.com/wp-content/uploads/sites/3/2022/10/S355J2AR-10-2022.pdf) | Facts quoted from the cited document | — |
| `ref:brr-en-gjl-250-c` | [brr-en-gjl-250-c](https://www.brr.ch/file/474/CMS/dokumente/Werkstoffdatenbl%C3%A4tter/datenblatt_guss_en-gjl-250-c.pdf) | Facts quoted from the cited document | — |
| `ref:thyssenkrupp-s235jr` | [thyssenkrupp-s235jr](https://ucpcdn.thyssenkrupp.com/_legacy/UCPthyssenkruppBAMXFrance/assets.files/product_pdf/carbon_flat_steel_/plates_and_slabs_carbon_steel/s235jr_1_0038_11_2016_engl.pdf) | Facts quoted from the cited document | — |
| `ref:makeitfrom-6061-o` | [makeitfrom-6061-o](https://www.makeitfrom.com/material-properties/6061-O-Aluminum) | Facts quoted from the cited document | — |
| `ref:makeitfrom-1-4034` | [makeitfrom-1-4034](https://www.makeitfrom.com/material-properties/Annealed-A-1.4034-Stainless-Steel) | Facts quoted from the cited document | — |
| `ref:makeitfrom-1-4057` | [makeitfrom-1-4057](https://www.makeitfrom.com/material-properties/Annealed-A-1.4057-Stainless-Steel) | Facts quoted from the cited document | — |
| `ref:wieland-b15-rp` | [wieland-b15-rp](https://www.wieland.com/en/content/download/9884/file/B15_RP_EN.pdf) | Facts quoted from the cited document | — |
| `ref:wieland-m10-rp` | [wieland-m10-rp](https://www.wieland.com/en/content/download/12537/file/M10_RP_EN.pdf) | Facts quoted from the cited document | — |
| `ref:wieland-m15-rp` | [wieland-m15-rp](https://www.wieland.com/en/content/download/9943/file/M15_RP_EN.pdf) | Facts quoted from the cited document | — |
| `ref:makeitfrom-c44300` | [makeitfrom-c44300](https://www.makeitfrom.com/material-properties/UNS-C44300-CW706R-Admiralty-Brass) | Facts quoted from the cited document | — |
| `ref:makeitfrom-c46400-o60` | [makeitfrom-c46400-o60](https://www.makeitfrom.com/material-properties/Soft-Annealed-O60-C46400-Brass) | Facts quoted from the cited document | — |
| `ref:makeitfrom-c65500-o61` | [makeitfrom-c65500-o61](https://www.makeitfrom.com/material-properties/Annealed-O61-C65500-Bronze) | Facts quoted from the cited document | — |
| `ref:makeitfrom-c12200` | [makeitfrom-c12200](https://www.makeitfrom.com/material-properties/UNS-C12200-CW024A-Phosphorized-Copper) | Facts quoted from the cited document | — |
| `ref:makeitfrom-c15000` | [makeitfrom-c15000](https://makeitfrom.com/material-properties/UNS-C15000-CW120C-Zirconium-Copper) | Facts quoted from the cited document | — |
| `ref:azom-c61400` | [azom-c61400](https://www.azom.com/article.aspx?ArticleID=6423) | Facts quoted from the cited document | — |
| `ref:makeitfrom-c64700` | [makeitfrom-c64700](https://www.makeitfrom.com/material-properties/UNS-C64700-Nickel-Silicon-Bronze) | Facts quoted from the cited document | — |
| `ref:azom-c70600` | [azom-c70600](https://www.azom.com/article.aspx?ArticleID=6297) | Facts quoted from the cited document | — |
| `ref:azom-c71500` | [azom-c71500](https://www.azom.com/article.aspx?ArticleID=6298) | Facts quoted from the cited document | — |
| `ref:webelements-rh` | [webelements-rh](https://www.webelements.co.uk/rhodium/physics.html) | Facts quoted from the cited document | — |
| `ref:webelements-mo` | [webelements-mo](https://www.webelements.co.uk/molybdenum/physics.html) | Facts quoted from the cited document | — |
| `ref:webelements-re` | [webelements-re](https://www.webelements.co.uk/rhenium/physics.html) | Facts quoted from the cited document | — |
| `ref:webelements-zr` | [webelements-zr](https://www.webelements.co.uk/zirconium/physics.html) | Facts quoted from the cited document | — |
| `ref:azom-goodfellow-peek` | [azom-goodfellow-peek](https://www.azom.com/article.aspx?ArticleID=1882) | Facts quoted from the cited document | — |
| `ref:makeitfrom-gpps` | [makeitfrom-gpps](https://www.makeitfrom.com/material-properties/General-Purpose-Polystyrene-GPPS) | Facts quoted from the cited document | — |
| `ref:diamond-materials-cvd-mechanical` | [diamond-materials-cvd-mechanical](https://diamond-materials.com/en/cvd-diamond/mechanical/) | Facts quoted from the cited document | — |
| `ref:makeitfrom-alpha-quartz` | [makeitfrom-alpha-quartz](https://www.makeitfrom.com/material-properties/Crystalline-Alpha-Quartz-Optical-Material) | Facts quoted from the cited document | — |
| `ref:crystran-sapphire` | [crystran-sapphire](https://www.crystran.com/optical-materials/sapphire-al2o3) | Facts quoted from the cited document | — |
| `ref:mwcomponents-elgin-5052-h32` | [mwcomponents-elgin-5052-h32](https://www.mwcomponents.com/uploads/Resource-Center/Elgin-Material-Sheets/Aluminum-5052-H32-Fact-Sheet_Elgin.pdf) | Facts quoted from the cited document | — |
| `ref:makeitfrom-5052-h32` | [makeitfrom-5052-h32](https://www.makeitfrom.com/material-properties/5052-H32-Aluminum) | Facts quoted from the cited document | — |
| `ref:cutwise-dc01` | [cutwise-dc01](https://www.cutwise.eu/materials/cold-rolled-steel) | Facts quoted from the cited document | — |
| `ref:makeitfrom-1008` | [makeitfrom-1008](https://www.makeitfrom.com/material-properties/SAE-AISI-1008-G10080-Carbon-Steel) | Facts quoted from the cited document | — |
| `ref:nippon-steel-slovakia-cold-rolled` | [nippon-steel-slovakia-cold-rolled](https://usske.sk/en/products/cold-rolled-steel/drawing-steel) | Facts quoted from the cited document | — |
| `ref:cutwise-dx51d-z275` | [cutwise-dx51d-z275](https://www.cutwise.eu/materials/hot-dip-galvanized-steel-dx51d-z275) | Facts quoted from the cited document | — |
| `ref:ssab-en10346-formable` | [ssab-en10346-formable](https://www.ssab.com/en/brands-and-products/steel-categories/coated-steel/metal-coated-formable-steels) | Facts quoted from the cited document | — |
| `ref:kloeckner-a572` | [kloeckner-a572](https://www.kloecknermetals.com/blog/a572-steel-explained-grades-applications-and-benefits) | Facts quoted from the cited document | — |
| `ref:ssab-a572-50` | [ssab-a572-50](https://www.ssab.com/en-us/brands-and-products/commercial-steel/structural-steel/astm-a572/grade-50) | Facts quoted from the cited document | — |
| `ref:kloeckner-ar400` | [kloeckner-ar400](https://www.kloecknermetals.com/blog/ar400-steel-what-it-is-how-its-used-and-why-it-matters/) | Facts quoted from the cited document | — |
| `ref:ssab-ar400f` | [ssab-ar400f](https://www.ssab.com/en-us/brands-and-products/commercial-steel/abrasion-resistant-steels/400f) | Facts quoted from the cited document | — |
| `ref:sendcutsend-ar500` | [sendcutsend-ar500](https://sendcutsend.com/materials/ar500/) | Facts quoted from the cited document | — |
| `ref:cmc-truwear-ar500f` | [cmc-truwear-ar500f](https://www.cmc.com/en-us/what-we-do/america/performance-steel/truwear-ar500f-plate) | Facts quoted from the cited document | — |
| `ref:panneaux-de-correze-medium-standard` | [panneaux-de-correze-medium-standard](https://medias.groupe-samse.fr/Fiche_technique/Fiche_technique_1395751.pdf) | Facts quoted from the cited document | — |
| `ref:kronospan-llc-mdf-hdf-specifications` | [kronospan-llc-mdf-hdf-specifications](https://cdn.byggtjeneste.no/nobb/070346fb-7e55-4fc8-aed9-9e27ed7b93fa) | Facts quoted from the cited document | — |
| `ref:timber-products-particleboard` | [timber-products-particleboard](https://aetnaplywood.com/wp-content/uploads/2024/08/Particleboard-Brochure.pdf) | Facts quoted from the cited document | — |
| `ref:metsa-wood-spruce-dop` | [metsa-wood-spruce-dop](https://www.metsagroup.com/globalassets/metsa-wood/dop-documents/dop_metsa_wood_spruce_2019-12-2_en.pdf) | Facts quoted from the cited document | — |
| `ref:metsa-wood-birch-pf-dop` | [metsa-wood-birch-pf-dop](https://www.metsagroup.com/globalassets/metsa-wood/dop-documents/dop_metsa_wood_birch_plywood_pf_2019-12-2_en.pdf) | Facts quoted from the cited document | — |
| `ref:sintef-smartply-osb3` | [sintef-smartply-osb3](https://www.sintefcertification.no/product/download/264) | Facts quoted from the cited document | — |

- **FreeCAD material cards** — `src/Mod/Material/Resources/Materials/Standard/**.FCMat` at commit `84ae7a7c8ee9e9c2c86c739f364ace4822caf950`
  (skipping `Default.FCMat`). Used: density, Young's and shear modulus, Poisson's ratio, yield, tensile and compressive
  strength, elongation (card `Elongation`, else `UltimateStrain`; a card value of 0 is read as missing), hardness with
  its scale, thermal conductivity, specific heat, thermal expansion, electrical conductivity. Each card keeps its own
  license; the record's `sources.freecad` names it with the card's author and the reference the card cites. Cards under
  CC-BY-SA-4.0 (PEEK, PMMA, POM copolymer, POM homopolymer) remain under CC-BY-SA-4.0; LGPL cards remain under their
  LGPL version. Attribution — FreeCAD project contributors, card authors by license:
  - CC-BY-3.0: Bernd Hahnebach, DaviKaur, Juergen Riegel, Michael Schloh von Bennewitz, Przemo Firszt, Uwe Stöhr, Yorik van Havre
  - CC-BY-4.0: FreeCAD
  - CC-BY-SA-4.0: FreeCAD
  - LGPL-2.0-or-later: Joe Da Silva, M. Münch, Uwe Stöhr
  - LGPL-2.1-or-later: Uwe Stöhr, vlk
- **Physically Based** (physicallybased.info, Anton Palmqvist and contributors) — `deploy/v2/materials.json` at commit `4d1f4b342087f2438f5f89db9d39246a4988b0f7`,
  CC0-1.0. Used: linear-sRGB base colors (metal F0), metalness, IOR and transmission for appearance, and densities
  (single values, or the typical third value of a range) for pure metals, crystals, glass, porcelain, brick, concrete,
  terracotta, marble, cardboard and EPS foam.
- **Wikidata** — curated items listed in `build.py`, queried once into `snapshots/wikidata.json`, CC0-1.0. Statements
  at 0–50 °C (or without a temperature) are used; statements outside their own stated limits, in units that can't be
  converted, or disagreeing by more than 10 % are skipped, and the chosen statement's temperature is noted.
- **Ultimaker fdm_materials** — generic filament profiles (`generic_*.xml.fdm_material`, 1.75 mm variants merged)
  and four flexible brand profiles (TPE SEBS 95A, TPU 60A, TPU 98A, printable silicone) at commit `886e7ad927463493cc9c64f427b1ae2cf4ce12c1`,
  CC0-1.0. Used: density (the profiles' color codes are UI colors, so filaments render with STEVE resin presets). Filament densities describe the raw filament, not a printed part's infill.
- **USDA Forest Products Laboratory, Wood Handbook** (FPL-GTR-282, 2021), Table 5–3a, public domain (U.S. Government
  work). 12 % moisture-content rows: modulus of elasticity (parallel to grain, static bending), modulus of rupture
  (`flexural_strength`), compression parallel to grain (`compressive_strength`) and side (Janka) hardness in N.
  Density is derived: ρ₁₂ = G₁₂ × 1.12 g/cm³ from the table's specific gravity (ovendry weight, volume at 12 % MC; Wood
  Handbook ch. 4). Species without a 12 % specific gravity are left out.
- **STEVE appearance presets** (`steve`) — rendering defaults written for STEVE where no dataset gives an appearance
  (natural polymer colors, wood tones, bronze, ceramics). CC0-1.0. They are appearance only, never engineering data.

Finishes (`finishes`) are STEVE rendering presets (CC0-1.0); their textures are listed in `../assets/NOTICE.md`.

## Citations

Materials Project data are used under CC BY 4.0 (https://next-gen.materialsproject.org), as a cross-check of measured
elastic moduli only. As its terms ask, we cite:

- A. Jain, S. P. Ong, G. Hautier, W. Chen, W. D. Richards, S. Dacek, S. Cholia, D. Gunter, D. Skinner, G. Ceder,
  K. A. Persson. The Materials Project: A materials genome approach to accelerating materials innovation.
  APL Materials 1, 011002 (2013). doi:10.1063/1.4812323
- M. de Jong, W. Chen, T. Angsten, A. Jain, R. Notestine, A. Gamst, M. Sluiter, C. Krishna Ande, S. van der Zwaag,
  J. J. Plata, C. Toher, S. Curtarolo, G. Ceder, K. A. Persson, M. Asta. Charting the complete elastic properties of
  inorganic crystalline compounds. Scientific Data 2, 150009 (2015). doi:10.1038/sdata.2015.9

Values from published reference documents (`ref:*` sources: producer datasheets, standards-body and national-laboratory
tables) are facts quoted from each document, which is linked above. Every one was proven against its document by
scripts/materials/verify_sources.py, and the quoted excerpt is kept in scripts/materials/snapshots/reference_evidence.json.
A few common stock materials no open dataset carries (`DATASHEET` in `build.py`: 5052-H32 aluminium, DC01 cold-rolled
steel, DX51D+Z275 galvanized steel, A572 Grade 50 structural plate, AR400 and AR500 wear plate, and the engineered wood
panels MDF, HDF/hardboard, particleboard, softwood and hardwood plywood and OSB) are made from such documents alone; a
property none of them prints stays `null`. Open datasets and the USDA Wood Handbook give panel densities only as ranges
or classes, so each panel's density is one producer's published mean or nominal value; panel density varies by product.

## Contents

| Category | Materials |
|---|---|
| Aluminum alloys | 9 |
| Carbon & alloy steels | 74 |
| Stainless steels | 10 |
| Cast irons | 18 |
| Titanium alloys | 2 |
| Copper alloys | 19 |
| Nickel alloys | 4 |
| Precious metals | 6 |
| Other metals | 18 |
| Plastics | 20 |
| 3D-printing filaments | 22 |
| Elastomers | 4 |
| Composites & fibres | 2 |
| Ceramics | 14 |
| Glass | 2 |
| Wood | 118 |
| Construction | 6 |
| Other | 4 |
| **Total** | **352** |

Materials drawing on each source (a material may use several):

| Source | Materials |
|---|---|
| FreeCAD material cards | 139 |
| Physically Based (physicallybased.info) | 169 |
| Wikidata | 64 |
| Ultimaker fdm_materials | 26 |
| USDA Forest Products Laboratory, Wood Handbook (FPL-GTR-282, 2021), Table 5-3a | 111 |
| STEVE appearance presets | 183 |
| dew-1-6582 | 1 |
| outokumpu-grades-properties | 9 |
| sci-p413-design-manual-stainless-4ed | 1 |
| ugitech-ugima-4057 | 1 |
| swisssteel-4057 | 1 |
| smc-inconel-625 | 1 |
| smc-inconel-718 | 1 |
| smc-nickel-200-201 | 1 |
| daido-titanium-properties | 2 |
| bikar-6061 | 1 |
| bikar-7020 | 1 |
| cda-c51000 | 1 |
| cda-c75200 | 1 |
| cda-c26000 | 1 |
| npl-kaye-laby-2-2-2 | 15 |
| npl-kaye-laby-2-3-5 | 19 |
| rsc-periodic-table | 5 |
| materion-truextent-tds2011 | 1 |
| nist-kim-ledbetter-1998-indium | 1 |
| eagle-alloys-rhenium | 1 |
| alleima-zr-702 | 1 |
| kyocera-sn241o | 1 |
| kyocera-sc211 | 1 |
| kyocera-ao479o | 1 |
| kyocera-an216a | 1 |
| kyocera-sa100 | 1 |
| saint-gobain-norbide-hp-b4c | 1 |
| schott-borofloat-33 | 1 |
| schott-borofloat-33-datasheet | 1 |
| agc-planibel | 1 |
| vasglass-float | 1 |
| crystran-mgo | 1 |
| crystran-crystal-quartz | 1 |
| goodfellow-hp-b4c | 1 |
| goodfellow-wc-co6 | 1 |
| element-six-balmer-2009 | 1 |
| meusburger-cf-h40s | 1 |
| roehm-plexiglas-gs-xt-211-1 | 1 |
| simona-pe-tech-info | 1 |
| roechling-polystone-g-100 | 1 |
| roechling-polystone-e | 1 |
| mdc-bakelite-pf31 | 1 |
| edmund-optics-ge-windows | 1 |
| edmund-optics-si-windows | 1 |
| sgl-sigrafine-r4550 | 1 |
| michelmersh-carlton-weathered-red | 1 |
| en1992-1-2-background-docs | 2 |
| heidelberg-betontechnische-daten-2022 | 2 |
| dew-1-6587-de | 1 |
| swisssteel-c45e-c45r | 1 |
| lucefin-30crnimo8 | 1 |
| lucefin-36crnimo4 | 1 |
| lucefin-36nicrmo16 | 1 |
| lucefin-c15e | 1 |
| lucefin-c35e | 1 |
| lucefin-c22e | 1 |
| lucefin-c30e | 1 |
| lucefin-c40e | 1 |
| lucefin-c55e | 1 |
| lucefin-c60e | 1 |
| arcelormittal-ommis-s355j2ar | 1 |
| brr-en-gjl-250-c | 1 |
| thyssenkrupp-s235jr | 1 |
| makeitfrom-6061-o | 1 |
| makeitfrom-1-4034 | 1 |
| makeitfrom-1-4057 | 1 |
| wieland-b15-rp | 2 |
| wieland-m10-rp | 1 |
| wieland-m15-rp | 1 |
| makeitfrom-c44300 | 1 |
| makeitfrom-c46400-o60 | 1 |
| makeitfrom-c65500-o61 | 1 |
| makeitfrom-c12200 | 2 |
| makeitfrom-c15000 | 1 |
| azom-c61400 | 1 |
| makeitfrom-c64700 | 1 |
| azom-c70600 | 1 |
| azom-c71500 | 1 |
| webelements-rh | 1 |
| webelements-mo | 1 |
| webelements-re | 1 |
| webelements-zr | 1 |
| azom-goodfellow-peek | 1 |
| makeitfrom-gpps | 1 |
| diamond-materials-cvd-mechanical | 1 |
| makeitfrom-alpha-quartz | 1 |
| crystran-sapphire | 1 |
| mwcomponents-elgin-5052-h32 | 1 |
| makeitfrom-5052-h32 | 1 |
| cutwise-dc01 | 1 |
| makeitfrom-1008 | 1 |
| nippon-steel-slovakia-cold-rolled | 1 |
| cutwise-dx51d-z275 | 1 |
| ssab-en10346-formable | 1 |
| kloeckner-a572 | 1 |
| ssab-a572-50 | 1 |
| kloeckner-ar400 | 1 |
| ssab-ar400f | 1 |
| sendcutsend-ar500 | 1 |
| cmc-truwear-ar500f | 1 |
| panneaux-de-correze-medium-standard | 1 |
| kronospan-llc-mdf-hdf-specifications | 1 |
| timber-products-particleboard | 1 |
| metsa-wood-spruce-dop | 1 |
| metsa-wood-birch-pf-dop | 1 |
| sintef-smartply-osb3 | 1 |

Values are nominal room-temperature figures as published by each source. They are not design allowables; check
supplier data before relying on them.
